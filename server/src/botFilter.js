// Recognizes automated hits that are NOT a human opening/clicking — mail
// security gateways prefetching images, "safe link" crawlers following
// every URL in an inbound email, chat-app link-preview bots, etc. This is
// the #1 cause of tracked emails showing "Opened"/"Clicked" before the
// recipient has actually done either — see README "Why did this open/click
// before anyone read it?" for details. Filtering these out at the source
// is more reliable than trying to guess after the fact.
const BOT_USER_AGENT_PATTERNS = [
  // Corporate email-security / "safe link" rewriting & prefetching
  /safelink/i,
  /atp-safelinks/i,
  /mimecast/i,
  /proofpoint/i,
  /barracuda/i,
  /forcepoint/i,
  /ironport/i,
  /zscaler/i,
  /trendmicro/i,
  /symantec/i,
  /fireeye/i,
  /mailscanner/i,
  /virustotal/i,
  /sophos/i,
  /fortinet|fortigate/i,
  /checkpoint/i,
  // Webmail providers proxying/prefetching remote images
  /googleimageproxy/i,
  /yahoo.*proxy/i,
  // Chat / social link-preview crawlers
  /facebookexternalhit/i,
  /slackbot/i,
  /twitterbot/i,
  /whatsapp/i,
  /linkedinbot/i,
  /discordbot/i,
  /telegrambot/i,
  /skypeuripreview/i,
  /pinterest/i,
  // Generic bot/crawler/spider signatures
  /\bbot\b/i,
  /crawler/i,
  /spider/i,
  /preview/i,
];

function isLikelyBotOrScanner(userAgent) {
  if (!userAgent || userAgent.trim() === "") return true; // real mail clients always send one
  return BOT_USER_AGENT_PATTERNS.some((re) => re.test(userAgent));
}

module.exports = { isLikelyBotOrScanner };
