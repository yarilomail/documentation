// Links to these are followed; every other external link gets rel="nofollow".
// Read by the markdown renderer and by scripts/check-nofollow.mjs.
const FOLLOWED = [
  url => url.hostname === 'seconddns.com' || url.hostname.endsWith('.seconddns.com'),
  url => url.hostname === 'yarilomail.org' || url.hostname.endsWith('.yarilomail.org'),
  url => url.hostname === 'github.com' && /^\/yarilomail(\/|$)/.test(url.pathname),
]

export function isFollowed(href) {
  let url
  try {
    url = new URL(href)
  } catch {
    return true // relative: a page of this site
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true
  return FOLLOWED.some(f => f(url))
}
