import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Response } from 'playwright';
import { PROFILE_DIR, DEFAULT_DASHBOARD_URL } from './config.js';
import type { Db } from './db.js';
import { log } from './logger.js';
import type { ConnectionState, ConnectionStatus } from './types.js';

export interface DashboardApiAccess {
  /** Actual API origin used by the dashboard (for example https://api.tickets.bot). */
  origin: string;
  /** Exact transcript list endpoint captured from the dashboard's own request. */
  transcriptsUrl: string;
  /** Authorization and x-tickets headers, held in memory only. */
  headers: Record<string, string>;
  capturedAt: string;
}

export class ConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly state: ConnectionState = 'not_connected',
  ) {
    super(message);
  }
}

function isTranscriptListResponse(response: Response): boolean {
  if (response.request().method() !== 'POST') return false;
  try {
    const url = new URL(response.url());
    return /\/api\/\d+\/transcripts\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export class ConnectionManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: ConnectionState = 'not_connected';
  private message = 'Not connected to the Tickets dashboard.';
  private lastVerifiedAt: string | null = null;
  private lastError: string | null = null;
  private observedUrl: string | null = null;
  private intentionalClose = false;
  private serial: Promise<unknown> = Promise.resolve();
  private apiAccess: DashboardApiAccess | null = null;

  constructor(private readonly db: Db) {}

  private get dashboardUrl(): string {
    return this.db.getSettings().dashboardUrl || DEFAULT_DASHBOARD_URL;
  }

  status(): ConnectionStatus {
    return {
      state: this.state,
      message: this.message,
      browserOpen: Boolean(this.context && this.page && !this.page.isClosed()),
      profileExists: fs.existsSync(PROFILE_DIR),
      lastVerifiedAt: this.lastVerifiedAt,
      lastError: this.lastError,
      dashboardUrl: this.dashboardUrl,
      observedUrl: this.observedUrl,
    };
  }

  private setState(state: ConnectionState, message: string): void {
    this.state = state;
    this.message = message;
    if (state !== 'authenticated') this.lastVerifiedAt = this.lastVerifiedAt;
    log('info', 'connection.state', { state, message });
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const next = this.serial.then(task, task);
    this.serial = next.catch(() => undefined);
    return next;
  }

  private async ensureContext(headed: boolean): Promise<BrowserContext> {
    if (this.context) {
      const browser = this.context.browser();
      if (!browser || browser.isConnected()) return this.context;
      this.context = null;
      this.page = null;
    }
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    this.setState(
      'browser_starting',
      headed
        ? 'Opening the dedicated TicketsManage browser window…'
        : 'Opening the dedicated browser session in the background…',
    );
    try {
      this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: !headed,
        // A fixed viewport locks the headed window to an emulated size. On
        // Windows displays with scaling this can place the OAuth Authorize
        // button below the physical screen and prevent resizing. `null` uses
        // a real, user-resizable browser window instead.
        viewport: null,
        locale: 'en-US',
        acceptDownloads: false,
        timeout: 30000,
        args: headed
          ? ['--start-maximized', '--window-position=0,0']
          : ['--window-size=1280,900'],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const hint = /ProcessSingleton|profile|locked|EBUSY|EPERM/i.test(message)
        ? ' Close any TicketsManage browser window that is already open, then retry.'
        : /Executable doesn't exist|browserType.launch/i.test(message)
          ? ' The Playwright Chromium browser is not installed. Run "npx playwright install chromium" once.'
          : '';
      this.lastError = message.slice(0, 500);
      this.setState(
        'not_connected',
        `The dedicated browser could not be opened.${hint}`,
      );
      throw new ConnectionError(
        `The dedicated browser could not be opened.${hint}`,
        'BROWSER_LAUNCH_FAILED',
        this.state,
      );
    }

    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    this.page.setDefaultTimeout(15000);
    this.page.setDefaultNavigationTimeout(this.db.getSettings().navigationTimeoutMs);
    // Discord may open OAuth or verification in a popup. Keep every popup in
    // front and resizable so a clipped Authorize button can always be reached.
    this.context.on('page', (popup) => {
      popup.setDefaultTimeout(15000);
      popup.bringToFront().catch(() => undefined);
      if (headed) void this.maximizeWindow(popup);
    });
    if (headed) void this.maximizeWindow(this.page);
    this.intentionalClose = false;
    this.context.on('close', () => {
      if (this.intentionalClose) return;
      this.context = null;
      this.page = null;
      this.setState('not_connected', 'The dedicated browser window was closed.');
    });
    log('info', 'browser.launched', { headed, profile: path.basename(PROFILE_DIR) });
    return this.context;
  }

  /** Maximise a headed window (including OAuth popups) through CDP. */
  private async maximizeWindow(page: Page): Promise<void> {
    if (!this.context || page.isClosed()) return;
    try {
      const session = await this.context.newCDPSession(page);
      const { windowId } = (await session.send('Browser.getWindowForTarget')) as {
        windowId: number;
      };
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'maximized' },
      });
      await session.detach();
    } catch {
      // Window management is best effort; the browser is still usable.
    }
  }

  private async currentPage(): Promise<Page> {
    if (!this.context) {
      await this.ensureContext(false);
    }
    if (!this.page || this.page.isClosed()) {
      this.page = this.context!.pages()[0] ?? (await this.context!.newPage());
      this.page.setDefaultTimeout(15000);
    }
    return this.page;
  }

  async connectForSignIn(): Promise<ConnectionStatus> {
    return this.withLock(async () => {
      try {
        await this.ensureContext(true);
        const page = await this.currentPage();
        // Re-maximise on every Connect, including when an existing window is
        // reused, so a previously clipped sign-in window becomes usable.
        await this.maximizeWindow(page);
        await page.bringToFront().catch(() => undefined);
        await page.waitForTimeout(300);
        this.observedUrl = page.url();
        try {
          await page.goto(this.dashboardUrl, {
            waitUntil: 'domcontentloaded',
            timeout: this.db.getSettings().navigationTimeoutMs,
          });
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.setState(
            'dashboard_unavailable',
            'The Tickets dashboard could not be reached. Check your internet connection and whether dashboard.tickets.bot is available.',
          );
          return this.status();
        }
        await page.waitForTimeout(1800);
        this.observedUrl = page.url();
        if (this.looksLikeLogin(page.url())) {
          this.setState(
            'waiting_for_signin',
            'Please finish signing in to the Tickets dashboard in the opened browser window. Return here when the Transcripts page is visible and select Verify connection. Do not paste your password or Discord token into this application.',
          );
          return this.status();
        }
        return await this.verifyInternal(page, false);
      } catch (error) {
        if (error instanceof ConnectionError) throw error;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setState(
          'unexpected_page',
          'The dedicated browser opened, but the dashboard verification could not complete. Inspect the browser window and select Verify connection.',
        );
        return this.status();
      }
    });
  }

  async verify(): Promise<ConnectionStatus> {
    return this.withLock(async () => {
      try {
        const page = await this.currentPage();
        return await this.verifyInternal(page, true);
      } catch (error) {
        if (error instanceof ConnectionError) {
          this.lastError = error.message;
          return this.status();
        }
        this.lastError = error instanceof Error ? error.message : String(error);
        this.setState(
          'unexpected_page',
          'Verification could not complete. Inspect the dashboard in the dedicated browser and try again.',
        );
        return this.status();
      }
    });
  }

  async ensureAuthenticated(): Promise<Page> {
    if (this.state === 'authenticated' && this.context && this.page && !this.page.isClosed()) {
      return this.page;
    }
    const status = await this.verify();
    if (status.state !== 'authenticated') {
      throw new ConnectionError(status.message, `CONNECTION_${status.state.toUpperCase()}`, status.state);
    }
    return this.page!;
  }

  /**
   * The dashboard's SPA calls api.tickets.bot with an Authorization bearer
   * token and an x-tickets header. Neither is a cookie, so Playwright's request
   * context cannot reproduce them from the saved profile. Capture them from
   * the dashboard's own request instead of guessing storage keys. Values are
   * kept in memory only and never logged.
   */
  private captureApiAccess(response: Response): void {
    try {
      const url = new URL(response.url());
      if (!/\/api\/\d+\/transcripts\/?$/.test(url.pathname)) return;
      const headers = response.request().headers();
      const authorization = headers.authorization;
      const xTickets = headers['x-tickets'];
      if (!authorization || !xTickets) return;
      this.apiAccess = {
        origin: url.origin,
        transcriptsUrl: `${url.origin}${url.pathname.replace(/\/$/, '')}`,
        headers: { authorization, 'x-tickets': xTickets },
        capturedAt: new Date().toISOString(),
      };
    } catch {
      // Capture is best effort; collection falls back to verified navigation.
    }
  }

  getApiAccess(): DashboardApiAccess | null {
    return this.apiAccess;
  }

  private looksLikeLogin(url: string): boolean {
    return /\/login|\/oauth2|\/callback|discord\.com\/oauth2|\/select-servers/i.test(url);
  }

  private async verifyInternal(page: Page, navigate: boolean): Promise<ConnectionStatus> {
    this.setState('browser_starting', 'Verifying access to the authenticated Transcripts interface…');
    this.lastError = null;
    const timeout = this.db.getSettings().navigationTimeoutMs;
    const responsePromise = page
      .waitForResponse((response) => isTranscriptListResponse(response), { timeout })
      .catch(() => null);

    try {
      if (navigate || !page.url().includes('dashboard.tickets.bot')) {
        const separator = this.dashboardUrl.includes('?') ? '&' : '?';
        await page.goto(`${this.dashboardUrl}${separator}verify=${Date.now()}`, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
      } else {
        await page.reload({ waitUntil: 'domcontentloaded', timeout });
      }
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setState(
        'dashboard_unavailable',
        'The Tickets dashboard did not load. Check your internet connection and whether dashboard.tickets.bot is available.',
      );
      return this.status();
    }

    await page.waitForTimeout(1200);
    this.observedUrl = page.url();
    if (this.looksLikeLogin(page.url())) {
      this.setState(
        'waiting_for_signin',
        'TicketsManage needs you to sign in to the Tickets dashboard. Complete the normal sign-in process in the opened browser window, then return here and click Verify connection. Do not paste passwords or Discord tokens into this application.',
      );
      return this.status();
    }

    const response = await responsePromise;
    if (response) this.captureApiAccess(response);
    if (!response) {
      const text = await page
        .locator('body')
        .innerText({ timeout: 3000 })
        .catch(() => '');
      const lower = text.toLowerCase();
      if (/sign in|log in|authorize/.test(lower) && /discord/.test(lower)) {
        this.setState(
          'waiting_for_signin',
          'The dashboard is showing a sign-in screen. Finish signing in in the dedicated browser, then select Verify connection.',
        );
      } else if (/no access|permission|not authorized|forbidden/.test(lower)) {
        this.setState(
          'access_denied',
          'Your account is signed in but does not appear to have access to this server’s Transcripts page. Ask a server administrator to grant the required dashboard permission.',
        );
      } else if (/transcripts/.test(lower)) {
        this.setState(
          'data_unavailable',
          'The Transcripts page loaded, but it did not return ticket data. Open the dashboard in the dedicated browser, confirm the Transcripts page lists tickets, then select Verify connection.',
        );
      } else {
        this.setState(
          'unexpected_page',
          'The dashboard page structure did not match the expected Transcripts interface. Open the Transcripts page in the dedicated browser, or export sanitized diagnostics for troubleshooting.',
        );
      }
      return this.status();
    }

    if (response.status() === 401) {
      this.setState(
        'session_expired',
        'The saved dashboard session has expired. Select Connect to the Tickets dashboard and sign in again.',
      );
      return this.status();
    }
    if (response.status() === 403) {
      this.setState(
        'access_denied',
        'The dashboard refused access to ticket transcripts for this account. Verify your server permissions, then select Verify connection.',
      );
      return this.status();
    }
    if (response.status() === 429) {
      this.setState(
        'data_unavailable',
        'The dashboard is rate-limiting requests. Wait a few minutes before verifying or collecting again.',
      );
      return this.status();
    }
    if (!response.ok()) {
      this.lastError = `Dashboard API returned HTTP ${response.status()}`;
      this.setState(
        'data_unavailable',
        `The Transcripts interface returned HTTP ${response.status()} instead of ticket data. Try again later.`,
      );
      return this.status();
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const transcripts = (body as { transcripts?: unknown } | null)?.transcripts;
    if (!Array.isArray(transcripts)) {
      this.setState(
        'unexpected_page',
        'The dashboard responded, but not with the expected transcript list. The site may have changed; export sanitized diagnostics before retrying.',
      );
      return this.status();
    }

    this.lastVerifiedAt = new Date().toISOString();
    this.setState(
      'authenticated',
      'Authenticated. The Transcripts interface is reachable and returned ticket data.',
    );
    log('info', 'connection.authenticated', { count: transcripts.length });
    return this.status();
  }

  async probeSavedSession(): Promise<void> {
    if (!this.db.getSettings().autoReuseSession) return;
    if (!fs.existsSync(PROFILE_DIR)) {
      this.setState('not_connected', 'No saved browser session yet. Select Connect to sign in.');
      return;
    }
    await this.withLock(async () => {
      try {
        await this.ensureContext(false);
        const page = await this.currentPage();
        const status = await this.verifyInternal(page, true);
        if (status.state !== 'authenticated') {
          await this.closeBrowser();
          this.setState(
            status.state === 'waiting_for_signin' ? 'waiting_for_signin' : status.state,
            status.state === 'waiting_for_signin'
              ? 'A saved session exists but is not signed in. Select Connect to open the dedicated browser and sign in.'
              : status.message,
          );
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        await this.closeBrowser();
        this.setState(
          'not_connected',
          'The saved browser session could not be reused automatically. Select Connect to open the dedicated browser.',
        );
      }
    });
  }

  /** Called by the collector when a live request proves the session is no longer valid. */
  reportAuthFailure(message: string): void {
    this.apiAccess = null;
    this.setState('session_expired', message);
    this.lastError = message;
  }

  reportDataProblem(state: ConnectionState, message: string): void {
    this.setState(state, message);
    this.lastError = message;
  }

  async openPage(): Promise<Page> {
    const context = await this.ensureContext(false);
    if (!this.page || this.page.isClosed()) {
      this.page = context.pages()[0] ?? (await context.newPage());
    }
    return this.page;
  }

  async disconnect(): Promise<ConnectionStatus> {
    await this.closeBrowser();
    this.apiAccess = null;
    this.setState('not_connected', 'Disconnected. The saved browser profile was kept for next time.');
    return this.status();
  }

  async resetProfile(): Promise<ConnectionStatus> {
    await this.closeBrowser();
    this.apiAccess = null;
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      log('info', 'browser.profile.reset');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw new ConnectionError(
        'The browser profile could not be deleted. Close the dedicated browser window and retry.',
        'PROFILE_RESET_FAILED',
      );
    }
    this.lastVerifiedAt = null;
    this.setState('not_connected', 'The dedicated browser profile was reset. Sign in again when ready.');
    return this.status();
  }

  private async closeBrowser(): Promise<void> {
    this.intentionalClose = true;
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        /* ignore */
      }
    }
    this.context = null;
    this.page = null;
    this.intentionalClose = false;
  }

  async shutdown(): Promise<void> {
    await this.closeBrowser();
  }
}
