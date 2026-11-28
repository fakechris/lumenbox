/**
 * A person's phones, in Settings → Mine (INV-2214, docs/110 §4): connecting one with a QR code, the list,
 * removing a lost one; and the "sign in again" a sign-in too old to mint a token or show a code is told
 * (INV-2318). No space beside a {blank} in the Chinese.
 */
export const UI_PHONES: Record<string, readonly [string, string]> = {
  "ui.next.mine.phones": ["手机", "Phones"],
  "ui.next.mine.phonesNote": ["用 LumenBox 手机应用扫码，手机就以你的身份登录。手机丢了就在这里移除：它会立刻退出登录，并清除保存的内容。", "Scan the code with the LumenBox phone app and the phone signs in as you. If a phone is lost, remove it here: it is signed out at once and wipes what it kept."],
  "ui.next.mine.connectPhone": ["连接手机", "Connect a phone"],
  "ui.next.mine.pairNote": ["用手机应用扫描这个二维码。它只能用一次，{minutes}分钟内有效。", "Scan this QR code with the phone app. It works once, for {minutes} minutes."],
  "ui.next.mine.pairAlt": ["连接手机的二维码", "QR code to connect a phone"],
  "ui.next.mine.noPhones": ["还没有连接手机。", "No phone is connected yet."],
  "ui.next.mine.removePhone": ["移除", "Remove"],
  "ui.next.mine.lastUsed": ["上次使用{when}", "last used {when}"],
  "ui.next.mine.signInAgain": ["重新登录", "Sign in again"],
  "ui.next.mine.platform.ios": ["iOS", "iOS"],
  "ui.next.mine.platform.android": ["Android", "Android"],
  "ui.next.mine.platform.macos": ["macOS", "macOS"],
  "ui.next.mine.platform.windows": ["Windows", "Windows"],
  "ui.next.mine.platform.linux": ["Linux", "Linux"],
};
