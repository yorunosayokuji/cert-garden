// iOS ビルド前の設定検査（純粋関数）。捏造した ID を登録せず、未設定は「ビルド前に」分かるようにする。
// 値の用意（bundle ID の決定、Expo アカウントと owner、eas init の projectId）は本人のアカウント作成後の作業。

const GOOGLE_IOS_CLIENT_ID = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

/** API の URL は HTTPS のみ（資格情報・クエリ・ハッシュなし）。localhost は署名ビルドでは不可 */
export function isProductionApiBase(raw) {
  if (typeof raw !== 'string') return false;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1' && u.hostname.includes('.');
}

/** 本人が決めるまで空のままにする必須項目（easJson を渡すと、署名ビルド用プロファイルの公開設定も検査する） */
export function missingForBuild(appJson, easJson) {
  const e = appJson?.expo ?? {};
  const missing = [];
  if (easJson) {
    for (const name of ['preview', 'production']) {
      const env = easJson.build?.[name]?.env ?? {};
      if (!isProductionApiBase(env.EXPO_PUBLIC_API_BASE_URL)) missing.push(`eas.json ${name}.env.EXPO_PUBLIC_API_BASE_URL（デプロイ後のHTTPSのURL）`);
      if (!GOOGLE_IOS_CLIENT_ID.test(String(env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? ''))) missing.push(`eas.json ${name}.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID（Google Cloud のiOSクライアントID。公開してよい識別子）`);
    }
  }
  const bundle = e.ios?.bundleIdentifier;
  if (typeof bundle !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/.test(bundle)) missing.push('expo.ios.bundleIdentifier（本人が決める逆ドメイン形式のID）');
  if (typeof e.owner !== 'string' || e.owner.trim() === '') missing.push('expo.owner（Expoアカウント作成後）');
  const projectId = e.extra?.eas?.projectId;
  if (typeof projectId !== 'string' || !/^[0-9a-f-]{36}$/i.test(projectId)) missing.push('expo.extra.eas.projectId（eas init の後）');
  return missing;
}

/** 設定ファイルとして常に満たすべき条件。ここが崩れていたらアカウントの有無に関係なく直す */
export function problems(appJson, easJson, pkgJson) {
  const out = [];
  // developmentClient=true のビルドには expo-dev-client が要る（無いと開発用の入口を持たないビルドになる）
  const usesDevClient = Object.values(easJson?.build ?? {}).some((p) => p?.developmentClient === true) || easJson?.build?.simulator?.extends === 'development';
  if (usesDevClient && pkgJson && !pkgJson.dependencies?.['expo-dev-client']) out.push('developmentClient のプロファイルがあるのに expo-dev-client が dependencies に無い');
  // 開発用の比較入口はこのプロファイルの環境変数で開く（native は __DEV__ も必要）
  if (easJson?.build?.development?.env?.EXPO_PUBLIC_IOS_DESIGN !== '1') out.push('development プロファイルに EXPO_PUBLIC_IOS_DESIGN=1 が無い（比較用の入口を開けない）');
  if (easJson?.build?.simulator && easJson.build.simulator.extends !== 'development') out.push('simulator プロファイルが development を継承していない');
  const e = appJson?.expo ?? {};
  if (e.ios?.config?.usesNonExemptEncryption !== false) out.push('ios.config.usesNonExemptEncryption が false ではない（暗号申告）');
  if (e.ios?.supportsTablet !== false) out.push('ios.supportsTablet が false ではない（iPhone専用の想定）');
  if (!e.scheme) out.push('scheme が未設定');
  if (e.ios?.usesAppleSignIn !== true) out.push('ios.usesAppleSignIn が true ではない（Appleでサインインの権限）');
  // 秘密は EXPO_PUBLIC_ に置かない（アプリの配布物に入ってしまう）。API の URL は HTTPS だけ
  for (const [pname, p] of Object.entries(easJson?.build ?? {})) {
    for (const [k, v] of Object.entries(p?.env ?? {})) {
      if (/^EXPO_PUBLIC_.*(SECRET|PRIVATE|TOKEN|PASSWORD|KEY|P8|CREDENTIAL)/i.test(k)) out.push(`${pname}.env.${k}: 秘密になりうる名前を EXPO_PUBLIC_ に置いている`);
      if (k === 'EXPO_PUBLIC_API_BASE_URL' && (pname === 'preview' || pname === 'production') && !isProductionApiBase(v)) out.push(`${pname}.env.${k} が HTTPS の本番URLではない`);
      if (k === 'EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID' && !GOOGLE_IOS_CLIENT_ID.test(String(v))) out.push(`${pname}.env.${k} の形が正しくない`);
    }
  }
  const b = easJson?.build ?? {};
  for (const name of ['development', 'simulator', 'preview', 'production']) {
    if (!b[name]) out.push(`eas.json に ${name} プロファイルが無い`);
  }
  if (b.simulator && b.simulator.ios?.simulator !== true) out.push('simulator プロファイルの ios.simulator が true ではない');
  if (b.development && b.development.developmentClient !== true) out.push('development プロファイルが developmentClient ではない');
  for (const name of ['preview', 'production']) {
    if (b[name]?.env && 'EXPO_PUBLIC_IOS_DESIGN' in b[name].env) out.push(`${name} に確認用入口の環境変数が入っている（署名ビルドで候補入口を開かない）`);
  }
  for (const ph of ['bundleIdentifier', 'owner']) {
    const v = ph === 'owner' ? e.owner : e.ios?.bundleIdentifier;
    if (typeof v === 'string' && /example|placeholder|todo|changeme|your/i.test(v)) out.push(`${ph} が仮の値に見える: ${v}`);
  }
  return out;
}
