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
  "page.bootstrap.operator": ["打开操作员的渠道设置。", "Open the operator's channel settings."],
  "page.bootstrap.operator-how": ["首次打开时，将 ?token= 加上操作员凭据放在安装首页地址后。凭据来自 AGENTBOX_UI_TOKEN，或启动日志中指明的 ui-token 文件。", "On first access, append ?token= and the operator credential to the installation's home URL. Use AGENTBOX_UI_TOKEN or the ui-token file named in the startup log."],
  "page.bootstrap.configure": ["在设置 → 渠道中打开添加渠道，输入飞书应用的 ID、密钥与渠道 ID，再保存。", "In Settings → Channels, open Add channel, enter the Feishu app ID, app secret and a channel ID, then save."],
  "page.bootstrap.register": ["将表单显示的 OAuth 回调地址登记到飞书应用中（用你的渠道 ID 替代 CHANNEL_ID）。", "Register the OAuth callback URL shown in the form in your Feishu app (replace CHANNEL_ID with your channel ID)."],
  "page.bootstrap.public-url": ["在服务器上将 AGENTBOX_PUBLIC_URL 设置为安装的公网 HTTPS 地址。", "Set AGENTBOX_PUBLIC_URL to the installation's public HTTPS address on the server."],
  "page.bootstrap.scan": ["回到此页，选择渠道、输入服务器文件中的一次性验证码，再扫码登录：", "Return here, select the channel, enter the one-use code from the server file, and scan the QR code:"],
  "page.bootstrap.code": ["验证码", "Code"],
  "page.bootstrap.channel": ["渠道", "Channel"],
  "page.bootstrap.sign-in": ["用飞书登录", "Sign in with Feishu"],
  "page.bootstrap.expires": ["验证码 24 小时后过期，只能用一次。", "The code expires after 24 hours and works once."],
  "page.bootstrap.no-channel": ["请先在这个安装上配置一个飞书渠道和公网地址。", "Configure a Feishu channel and public URL on this installation first."],
  // The sign-in page's channel buttons (GET /login, INV-1701): one button per Feishu channel, above the invite code.
  "page.login.with-channel": ["用 {channel} 登录", "Sign in with {channel}"],
  "page.login.or-code": ["或者，用管理员给你的邀请码：", "Or with an invite code from an admin:"],
  "page.recovery.sign-in-required": ["请登录 LumenBox", "Sign in to LumenBox"],
  "page.recovery.access-removed": ["你的访问权限已被移除", "Your access was removed"],
  "page.recovery.session-expired": ["你的会话已过期", "Your session expired"],
  "page.recovery.sign-in-expired": ["登录二维码已过期", "Your sign-in QR code expired"],
  "page.recovery.contact": ["如果无法重新登录，请联系本安装的管理员。", "If you can't sign in again, contact this installation's administrator."],
  "page.recovery.login": ["前往登录", "Go to sign-in"],
  // A sign-in this installation does not know yet.
  "page.not-linked.title": ["这个飞书账号还没有链接到本安装", "This Feishu account is not linked to this installation yet"],
  "page.not-linked.your-id": ["你的 id：", "Your id: "],
  "page.not-linked.how": ["在飞书里给本安装的 agent 发一条消息，管理员会收到放行提示；或者向管理员要一个邀请码，在聊天里发送 bind 邀请码。链接完成后回到这里重新打开即可。", "Send a message to this installation's agent in Feishu and an admin is asked to let you in; or ask an admin for an invite code and send bind followed by the code in the chat. Once linked, open this page again."],
  // Where a connector's authorization comes back (GET /oauth/callback).
  "page.oauth.connected": ["已连接 {provider}", "Connected {provider}"],
  "page.oauth.connected-how": ["token 已存进这台机器的密钥库。可以关掉这个标签页，到 设置 → 渠道 → 连接器 里把它授权给谁。", "The token is in this machine's vault. You can close this tab and grant it in Settings → Channels → Connectors."],
  "page.oauth.not-connected": ["没有连接", "Not connected"],
  // A channel's status on Settings → Channels (channels/status-line.ts, INV-1702). Variable names stay as typed.
  "channel.status.starting": ["正在启动", "starting"],
  "channel.status.connected": ["已连接", "connected"],
  "channel.status.set-one": ["请设置 {name}", "set {name}"],
  "channel.status.set-two": ["请设置 {first} 和 {second}", "set {first} and {second}"],
  "channel.status.socket-ready": ["连接正常，已持续 {minutes} 分钟", "socket ready for {minutes}m"],
  "channel.status.socket-connecting": ["正在连接（{minutes} 分钟）", "socket connecting ({minutes}m)"],
  "channel.status.socket-lost": ["{minutes} 分钟前断开，正在重连", "socket lost {minutes}m ago; reconnecting"],
  "channel.status.socket-lost-why": ["{minutes} 分钟前断开（{why}），正在重连", "socket lost {minutes}m ago ({why}); reconnecting"],
  // A desktop frame before noVNC answers.
  "page.desktop.title": ["桌面", "desktop"],
  "page.desktop.starting": ["桌面正在启动…", "Desktop is starting…"],
  "page.desktop.box-down": ["box 暂时不可用。用 agentbox box up 启动它。", "The box is not available. Start it with agentbox box up."],
};
