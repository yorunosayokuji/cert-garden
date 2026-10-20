// app.json を土台に、ビルド時の環境だけで決まる設定を足す。秘密は読まない・書かない。
//  1. Google の iOS 用 URL スキーム（EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID が有効な形の時だけ。未設定は check:ios-config:build が止める）
//  2. App Transport Security（ATS）: 製品のビルドは HTTPS だけ。開発のビルドだけ Expo の既定（開発サーバーへの http）を残す
//     根拠: https://reactnative.dev/docs/network （ATS は http に例外が要る。ATS を丸ごと無効にするより既知のドメインだけ例外にする方が安全）
//     開発の判定: EAS の profile が development / simulator、または EAS の外(local prebuild)で比較フラグ EXPO_PUBLIC_IOS_DESIGN=1 の時。
//     それ以外（preview / production / 判定できない時）は NSAllowsArbitraryLoads=false で、localhost 等の例外も付けない。
//     EAS_BUILD_PROFILE は EAS の build job の中にだけある（https://docs.expo.dev/eas/environment-variables/usage/ ）。
const GOOGLE_IOS_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;
const DEV_PROFILES = ['development', 'simulator'];

/** クライアントIDのドット区切りを逆順にしたもの（Google の iOS 向け案内の URL スキーム） */
function reversedClientId(id) {
  return id.split('.').reverse().join('.');
}

/** 開発のビルドか。profile が分かる時はそれだけで決める（preview / production / 未知は開発ではない） */
function isDevBuild(env) {
  const profile = env.EAS_BUILD_PROFILE;
  if (profile) return DEV_PROFILES.includes(profile);
  return env.EXPO_PUBLIC_IOS_DESIGN === '1';
}

module.exports = ({ config }) => {
  const env = process.env;
  let out = config;
  const gid = (env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '').trim();
  if (GOOGLE_IOS_CLIENT_ID.test(gid)) {
    const schemes = [].concat(config.scheme || []);
    const reversed = reversedClientId(gid);
    if (!schemes.includes(reversed)) schemes.push(reversed);
    out = { ...out, scheme: schemes };
  }
  if (!isDevBuild(env)) {
    const ios = out.ios ?? {};
    out = { ...out, ios: { ...ios, infoPlist: { ...(ios.infoPlist ?? {}), NSAppTransportSecurity: { NSAllowsArbitraryLoads: false } } } };
  }
  return out;
};

module.exports.reversedClientId = reversedClientId;
module.exports.isDevBuild = isDevBuild;
