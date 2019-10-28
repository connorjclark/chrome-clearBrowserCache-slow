/*
78.0.3904.70 Mac

Commands are:
1. Network.clearBrowserCache
2. Network.setCacheDisabled { cacheDisabled: true }
3. Network.setCacheDisabled { cacheDisabled: false }

Headless:
Command #1 & #3 - takes <10ms
Command #2 - takes ~70ms

Headfull:
Command #1 - takes 1000ms - 10000ms
Command #2 & #3 - always takes <10ms
subsequent calls to Command #1 always finish quickly
initial calls to Command #1 (when browser is first opened) always take long.

Code:
https://cs.chromium.org/chromium/src/content/browser/devtools/protocol/network_handler.cc?l=1102&rcl=7294eccddbe70421b419aa5eefc171e468c2cdbe
https://cs.chromium.org/chromium/src/content/browser/browsing_data/browsing_data_remover_impl.cc?l=593&rcl=7294eccddbe70421b419aa5eefc171e468c2cdbe

*/

// Lighthouse's function, for reference.
// async function cleanBrowserCaches() {
//   const status = { msg: 'Cleaning browser cache', id: 'lh:driver:cleanBrowserCaches' };
//   log.time(status);

//   // Wipe entire disk cache
//   await this.sendCommand('Network.clearBrowserCache');
//   // Toggle 'Disable Cache' to evict the memory cache
//   // Confirmed: these commands take <1ms.
//   await this.sendCommand('Network.setCacheDisabled', { cacheDisabled: true });
//   await this.sendCommand('Network.setCacheDisabled', { cacheDisabled: false });

//   log.timeEnd(status);
// }

const http = require('http');
const fs = require('fs');
const path = require('path');
const decompress = require('decompress');
const log = require('lighthouse-logger');
const ChromeLauncher = require('chrome-launcher');
const ChromeProtocol = require('lighthouse/lighthouse-core/gather/connections/cri.js');

// got this from the bisect-builds.py script
// -b 499098 -g 681094
// 62.0.3202.0 to 77.0.3865.120
const macRevisions = require('./mac-revisions.json');

async function wrapLog(status, fn) {
  log.time(status);
  await fn();
  log.timeEnd(status);
}


/**
 * @param {number[]} values
 */
function sum(values) {
  return values.reduce((sum, value) => sum + value);
}

/**
 * @param {number[]} values
 */
function average(values) {
  return sum(values) / values.length;
}

async function getConnection(chrome) {
  const connection = new ChromeProtocol(chrome.port);
  await connection.connect();
  return connection;
}

async function getChromeVersion(connection) {
  const version = await connection.sendCommand('Browser.getVersion');
  const match = version.product.match(/\/(\d+)/); // eg 'Chrome/71.0.3577.0'
  const milestone = match ? parseInt(match[1]) : 0;
  return Object.assign(version, { milestone });
}

async function getTiming(connection) {
  await wrapLog({ msg: 'Cleaning browser cache', id: 'lh:driver:cleanBrowserCaches' },
    () => connection.sendCommand('Network.clearBrowserCache'));
  // Focusing on just the first command.
  // await wrapLog({ msg: 'Cleaning browser cache - 2', id: 'lh:driver:cleanBrowserCaches:2' },
  //   () => connection.sendCommand('Network.setCacheDisabled', { cacheDisabled: true }));
  // await wrapLog({ msg: 'Cleaning browser cache - 3', id: 'lh:driver:cleanBrowserCaches:3' },
  //   () => connection.sendCommand('Network.setCacheDisabled', { cacheDisabled: false }));
}

async function runForChrome(chromePath, n) {
  let version;

  // Restart chrome for each iteration.
  for (let i = 0; i < n; i++) {
    const userDataDir = `${__dirname}/.tmp-chrome-user-dir`;
    fs.mkdirSync(userDataDir, {recursive: true});
    const chrome = await ChromeLauncher.launch({
      chromePath,
      chromeFlags: [
        // '--headless',

        // '--trace-startup',
        // '--trace-to-file',

        '--enable-logging',
        '--vmodule=browsing_data_remover_impl=1,chrome_browsing_data_remover_delegate=1,webrtc_event_log_manager_remote=1,webrtc_event_log_manager=1',
        '--v=0',
      ],
      userDataDir,
    });
    const connection = await getConnection(chrome);
    if (i === 0) version = await getChromeVersion(connection);

    await getTiming(connection);

    await connection.disconnect();
    await chrome.kill();
  }

  const timings = log.takeTimeEntries();
  return {
    version,
    timings,
    average: average(timings.map(t => t.duration)),
  };
}

async function downloadChrome(revision) {
  const outputFolder = `revisions/chrome-${revision}`;
  if (!fs.existsSync(outputFolder)) {
    const url = `http://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/${revision}/chrome-mac.zip`;
    const file = fs.createWriteStream('chrome-mac.zip');
    await new Promise((resolve, reject) => {
      http.get(url, (response) => {
        response.pipe(file);
        response.on('close', resolve);
        response.on('error', reject);
      });
    });
    file.close();

    await decompress('chrome-mac.zip', `revisions/chrome-${revision}`);
    fs.unlinkSync('chrome-mac.zip');
  }

  return `${outputFolder}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`;
}

async function makeGraph(argv) {
  function render(data) {
    window.onload = function () {
      const plotdata = [
        {
          type: 'scatter',
          y: data.map(d => d.version),
          x: data.map(d => d.average),
        }
      ];
      const el = document.getElementById('charts').appendChild(document.createElement('div'));
      Plotly.newPlot(el, plotdata, {height: 1000});
    }
  }

  const graphData = [];
  for (const graph of argv.graph) {
    graphData.push(...require(path.resolve(process.cwd(), graph)));
  }

  const data = graphData.map(d => {
    return {
      version: d.version.product,
      average: average(d.timings.map(t => t.duration)),
    };
  });
  data.sort((a, b) => a.version.localeCompare(b.version))
  const html = `
  <body>
    <div id="charts"></div>
    <script src="https://cdn.plot.ly/plotly-latest.js" charset="utf-8"></script>
    <script>(${render.toString()})(
      ${JSON.stringify(data)},
      ${JSON.stringify(['revision', 'average'])}
    );</script>
  </body>
  `;
  fs.writeFileSync('graph.html', html);
}

async function main(argv) {
  const results = [];
  const n = argv.n;

  if (argv.useChromePath) {
    results.push(await runForChrome(process.env.CHROME_PATH, n));
  } else {
    let revisions;
    if (argv.revision) {
      revisions = [argv.revision];
    } else {
      revisions = macRevisions
        .filter(r => r >= argv.begin && r <= argv.end)
        .filter((r, index) => r === argv.begin || r === argv.end || index % argv.delta === 0);
    }
    console.log(`Num revisions: ${revisions.length}`);

    for (const revision of revisions) {
      console.log(revision);
      const chromePath = await downloadChrome(revision);
      const result = await runForChrome(chromePath, n);
      result.version.r = revision;
      results.push(result);
    }
  }

  console.log(JSON.stringify(results, null, 2));

  if (argv.exitCode) {
    if (results.length !== 1) throw new Error('unexpected args');
    const slow = results[0].average > 1000;
    process.exit(slow ? 1 : 0);
  }
}

const argv = require('yargs')
  .boolean('use-chrome-path')
  .default('begin', macRevisions[0])
  .default('end', macRevisions[macRevisions.length - 1])
  .default('delta', 1000)
  .default('n', 10)
  .array('graph')
  .argv;

if (argv.graph) {
  makeGraph(argv);
} else {
  main(argv);
}
