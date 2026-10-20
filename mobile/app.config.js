// app.json を土台に、ビルド時の環境変数（公開してよい識別子だけ）で Google の iOS 用 URL スキームを足す。
// 秘密は読まない・書かない。EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID が未設定/形が違えば何も足さない（未設定はビルド前の検査 check:ios-config:build が止める）。
const GOOGLE_IOS_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

/** クライアントIDのドット区切りを逆順にしたもの（Google の iOS 向け案内の URL スキーム） */
function reversedClientId(id) {
  return id.split('.').reverse().join('.');
}

module.exports = ({ config }) => {
  const gid = (process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID || '').trim();
  if (!GOOGLE_IOS_CLIENT_ID.test(gid)) return config;
  const schemes = [].concat(config.scheme || []);
  const reversed = reversedClientId(gid);
  if (!schemes.includes(reversed)) schemes.push(reversed);
  return { ...config, scheme: schemes };
};

module.exports.reversedClientId = reversedClientId;
