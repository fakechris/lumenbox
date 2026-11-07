/**
 * The words the web server writes itself rather than the page (INV-1686): the pages it answers
 * with before the workshop exists — the first Admin's sign-in, a connector's return, a sign-in
 * this installation does not know, a desktop still starting — and the usage forecast line on
 * Settings → Model.
 *
 * One line per key: `[zh, en]`, as the page's words are (`ui-*.ts`). `quota_hold`, model names
 * and file names stay as written: they are what a person types or searches for.
 */

export const SERVER_WORDS: Record<string, readonly [zh: string, en: string]> = {
  // The usage forecast (host/quota-window.ts). Sentences are joined, so each carries its own end.
  "quota.not-a-bill": ["这是预测，不是账单。", "Forecast, not a bill."],
  "quota.rolling-5h": ["最近 5 小时：{amount}{clears}。", "Rolling 5h {amount}{clears}."],
  "quota.clears": ["（{at} 清空）", " (clears {at})"],
  "quota.rolling-7d": ["最近 7 天：{amount}。", "Rolling 7d {amount}."],
  "quota.week-caveat": ["7 天的数字只算用量账本里还留着的记录（默认 48 小时）。两个窗口都从现在往回滚动，只能近似供应商从首次使用开始计算的窗口。", "The 7d figure only sees what the ledger still holds (default 48h). Both windows roll from now, which only approximates a vendor window that starts at first use."],
  "quota.list-priced": ["{models} 的输入价没有配置或低于 1，按 2026-11-04 的中国标价计算（每百万 1 / 4 / 0.1）。", "{models} uses the 2026-11-04 China list (1 / 4 / 0.1 per million) where the configured input was missing or below 1."],
  "quota.unpriced": ["未定价：{models}", "unpriced {models}"],
  "quota.empty": ["无记录", "empty"],
  "quota.hold-yes": ["暂停：是（quota_hold）。", "Hold: yes (quota_hold)."],
  "quota.hold-no-line": ["暂停：否（没有设暂停线）。", "Hold: no (no pause line)."],
  "quota.hold-no": ["暂停：否。", "Hold: no."],
  "quota.ledger-unreadable": ["读不到用量账本。", "The usage ledger could not be read."],
  "quota.remains-hold": ["剩余额度的通用窗口暂停到 {until}（quota_hold）。", "Remains general window holds until {until} (quota_hold)."],
  "quota.window-resets": ["窗口重置时", "the window resets"],
  // The first Admin's sign-in page (GET /bootstrap).
  "page.bootstrap.title": ["首位管理员", "First administrator"],
  "page.bootstrap.lead": ["从这个安装本地的 bootstrap-code 文件里取出一次性验证码，用飞书登录，成为它的第一位管理员。", "Retrieve the one-use code from the installation's local bootstrap-code file. Sign in with Feishu to become its first administrator."],
  "page.bootstrap.code": ["验证码", "Code"],
  "page.bootstrap.channel": ["渠道", "Channel"],
  "page.bootstrap.sign-in": ["用飞书登录", "Sign in with Feishu"],
  "page.bootstrap.expires": ["验证码 24 小时后过期，只能用一次。", "The code expires after 24 hours and works once."],
  "page.bootstrap.no-channel": ["请先在这个安装上配置一个飞书渠道和公网地址。", "Configure a Feishu channel and public URL on this installation first."],
  // The sign-in page's doors (GET /login, INV-1701): one button per Feishu channel, above the invite code.
  "page.login.with-door": ["用 {door} 登录", "Sign in with {door}"],
  "page.login.or-code": ["或者，用管理员给你的邀请码：", "Or with an invite code from an admin:"],
  // A sign-in this installation does not know yet.
  "page.not-linked.title": ["这个飞书账号还没有链接到本安装", "This Feishu account is not linked to this installation yet"],
  "page.not-linked.your-id": ["你的 id：", "Your id: "],
  "page.not-linked.how": ["在飞书里给本安装的 agent 发一条消息，管理员会收到放行提示；或者向管理员要一个邀请码，在聊天里发送 bind 邀请码。链接完成后回到这里重新打开即可。", "Send a message to this installation's agent in Feishu and an admin is asked to let you in; or ask an admin for an invite code and send bind followed by the code in the chat. Once linked, open this page again."],
  // Where a connector's authorization comes back (GET /oauth/callback).
  "page.oauth.connected": ["已连接 {provider}", "Connected {provider}"],
  "page.oauth.connected-how": ["token 已存进这台机器的密钥库。可以关掉这个标签页，到 设置 → 渠道 → 连接器 里把它授权给谁。", "The token is in this machine's vault. You can close this tab and grant it in Settings → Channels → Connectors."],
  "page.oauth.not-connected": ["没有连接", "Not connected"],
  // A desktop frame before noVNC answers.
  "page.desktop.title": ["桌面", "desktop"],
  "page.desktop.starting": ["桌面正在启动…", "Desktop is starting…"],
  "page.desktop.box-down": ["box 暂时不可用。用 agentbox box up 启动它。", "The box is not available. Start it with agentbox box up."],
};
