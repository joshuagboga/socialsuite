// How X counts a post: most emoji and CJK characters weigh 2, and every link counts as 23.
// The server imports this directly. `npm run build:js` bundles the same file into
// public/vendor/xcount.js for the composer, so the browser and the server always agree.

import twitterText from "twitter-text";

export function xLength(text, limit = 280) {
  return twitterText.parseTweet(String(text ?? ""), {
    ...twitterText.configs.defaults, maxWeightedTweetLength: limit,
  }).weightedLength;
}
