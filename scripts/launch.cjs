const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const PREFERRED_PORT = 5178;
const PORT_SEARCH_END = 5200;
const HEALTH_PATH = '/api/health';
const APP_DIR = path.resolve(__dirname, '..');

async function probe(port, timeoutMs = 800) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: controller.signal,
    });
    clearTimeout(id);
    const text = await res.text();
    return { inUse: true, isTicketsManage: res.status === 200 && text.includes('"ok"') };
  } catch {
    return { inUse: false, isTicketsManage: false };
  }
}

function waitForHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      probe(port, 500).then((result) => {
        if (result.inUse && result.isTicketsManage) return resolve(port);
        if (Date.now() - start > timeoutMs)
          return reject(new Error(`Health check timed out after ${timeoutMs}ms`));
        setTimeout(check, 500);
      });
    })();
  });
}

function findFreePort(start, end) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(start, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      if (start < end) {
        resolve(findFreePort(start + 1, end));
      } else {
        const s = net.createServer();
        s.listen(0, '127.0.0.1', () => {
          const port = s.address().port;
          s.close(() => resolve(port));
        });
        s.on('error', () => resolve(null));
      }
    });
  });
}

function openUrl(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // opening the browser is best effort
  }
}

async function ensureBuild() {
  console.log('Building the local interface...');
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['run', 'build:web'], {
      cwd: APP_DIR,
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (code) =>
    code === 0 ? resolve(0) : reject(new Error(`Build exited with code ${code}`)),
  );
});
}

async function tryStartOnPort(port) {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['start'], {
      cwd: APP_DIR,
      env: { ...process.env, PORT: String(port) },
      shell: process.platform === 'win32',
      stdio: 'pipe',
    });

    let stderr = '';
    child.stderr.on('data', (d) => {
      process.stderr.write(d);
      stderr += d.toString();
    });
    child.stdout.on('data', (d) => process.stdout.write(d));

    waitForHealth(port, 20000)
      .then(() => resolve({ child, port }))
      .catch((err) => {
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
        reject(err);
      });

    child.on('exit', (code) => {
      if (code === 1 && /already in use/i.test(stderr)) {
        reject(new Error(`EADDRINUSE on port ${port}`));
      }
    });
  });
}

function setupShutdown(child) {
  const shutdown = () => {
    console.log('\nShutting down TicketsManage...');
    child.kill('SIGTERM');
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  child.on('exit', (code, signal) => {
    console.log(
      `TicketsManage exited with code ${code}${signal ? `, signal ${signal}` : ''}`,
    );
    process.exit(code ?? 0);
  });
}

async function main() {
  console.log(`TicketsManage launcher`);

  try {
    await ensureBuild();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const startPort = PREFERRED_PORT;

  for (let port = startPort; port <= PORT_SEARCH_END; port++) {
    const existing = await probe(port, 300);
    if (existing.inUse) {
      console.log(`Port ${port} is occupied by another application. Skipping...`);
      continue;
    }

    console.log(`Starting TicketsManage on port ${port}...`);
    try {
      const { child } = await tryStartOnPort(port);
      console.log(`TicketsManage is running at http://127.0.0.1:${port}`);
      openUrl(`http://127.0.0.1:${port}`);
      setupShutdown(child);
      await new Promise(() => {});
      return;
    } catch (err) {
      if (/EADDRINUSE/.test(err.message)) {
        console.log(`Port ${port} became occupied during startup. Trying next port...`);
        continue;
      }
      console.error(`Startup failed on port ${port}: ${err.message}`);
    }
  }

  console.error(
    'Could not start TicketsManage on any port in the expected range. Please free a port and try again.',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
