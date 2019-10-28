# Network.clearBrowserCache: Why Art Thou Slow?

See: https://docs.google.com/document/d/1va_h2uei_-H-AjXMSxdSOat2vkwD4FKREn_CK-wRZes/edit?usp=sharing

The following are my notes.

Tested on 78.0.3904.70 Mac

As of today (78.0.3904.70), the `clear cache` stage in Lighthouse can take between 1 and 10 seconds. Before 77.0.3830.0, the upper bound for this stage was 100ms.

The `clear cache` stage issues three protocol commands:

1. Network.clearBrowserCache
1. Network.setCacheDisabled { cacheDisabled: true }
1. Network.setCacheDisabled { cacheDisabled: false }

These commands have different durations depending on if the browser is headless or not. Some characteristics include...

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

# Historical `Network.clearBrowserCache` timings

Collect a large snapshot of timings, going back to M62 (~2yrs ago)

`node main.js -n 10`

r499098 to r681090 (62.0.3202.0 to 77.0.3865.120), delta 1000
This tests 21 revisions

First 18 (up to Chrome/76.0.3806.0) all took <100ms
The last 3 are interesting

First bad at r670017 (77.0.3830.0) (previous good was r663436)
But good again at r676487 (77.0.3851.0)
Then bad again at r681090 (77.0.3865.0)

A smaller snapshot, focusing on when things got slow:

```sh
node main.js -n 10 --begin 663436 --end 681090 --delta 100 > results/x.json
```

Question 1: What went bad between r663436 and r670017?
Question 2: What went good between r670017 and r676487?
Question 3: What went bad again between r676487 and r681090?

# 2 Question 1: What went bad between r663436 and r670017?

```sh
tools/bisect-builds.py --use-local-cache --verify-range -a mac64 -g 663436 -b 670017 --not-interactive -c 'bash -c "cd ~/src/chrome-clear-cache && CHROME_PATH=%p node main.js -n 3 --exit-code --use-chrome-path"'
```

Answer: https://chromium.googlesource.com/chromium/src/+/1b2aef7ac8b8b5422c5ea7f02352059ab28e05ee
Note, this is a reland, so a more granular look at this revision range may show more transitions from bad -> good -> bad.

However, simply setting the posted tasks' priority to `TaskPriority::USER_BLOCKING` did not change anything.

There are 6 async operations performed in `BrowsingDataRemoverImpl` when DevTools clears the cache - logging shows that the only one that is slow is `kEmbedderData`. A trace for the async event `browsing_data` shows the same.

https://cs.chromium.org/chromium/src/chrome/browser/browsing_data/chrome_browsing_data_remover_delegate.cc?l=316&rcl=2eb17bcb2d6becb872cbedbb9c8c1ded535a3de0

`TracingDataType::kWebrtcEventLogs` 

https://cs.chromium.org/chromium/src/chrome/browser/media/webrtc/webrtc_event_log_manager.cc?l=186&rcl=437cc0651efff42554224b5d3e66cf440214122d is marked best effort.

# 3 Question 3: What went good between r670017 and r676487?

```sh
tools/bisect-builds.py --use-local-cache --verify-range -a mac64 -g 676487 -b 670017 --not-interactive -c 'bash -c "cd ~/src/chrome-clear-cache && CHROME_PATH=%p node main.js -n 3 --exit-code --use-chrome-path"' > /Users/cjamcl/src/chrome-clear-cache/results/3.json
```

Answer: https://chromium.googlesource.com/chromium/src/+/ba6689657c4463b8468cd2d61002790070d602e0 revert of 1b2aef

# 4 Question 3: What went bad again between r676487 and r681090?

reland #2 https://bugs.chromium.org/p/chromium/issues/detail?id=887407#c38
