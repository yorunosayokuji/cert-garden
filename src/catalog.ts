// 初期対応10資格のカタログ。存在は教材の完成を意味しない（contentStatus 参照）。
export type ContentStatus = 'sample_theme' | 'not_authored';

export interface Domain {
  id: string;
  name: string;
}

export interface Qualification {
  id: string;
  name: string;
  grade?: string;
  /** 出題領域。公式資料で未確認のものは空配列 + domainsConfirmed=false */
  domains: Domain[];
  domainsConfirmed: boolean;
  contentStatus: ContentStatus;
}

export interface Theme {
  qualificationId: string;
  id: string;
  domainId: string;
  title: string;
}

const unconfirmed = (id: string, name: string, grade?: string): Qualification => ({
  id,
  name,
  grade,
  domains: [],
  domainsConfirmed: false,
  contentStatus: 'not_authored',
});

export const QUALIFICATIONS: Qualification[] = [
  {
    id: 'it-passport',
    name: 'ITパスポート',
    domains: [
      { id: 'strategy', name: 'ストラテジ系' },
      { id: 'management', name: 'マネジメント系' },
      { id: 'technology', name: 'テクノロジ系' },
    ],
    domainsConfirmed: false, // 分野名は一般に知られる区分。シラバスVer.6.5での再確認は今回未実施
    contentStatus: 'sample_theme',
  },
  unconfirmed('nissho-boki-3', '日商簿記', '3級'),
  unconfirmed('toukei-3', '統計検定', '3級'),
  unconfirmed('qc-3', 'QC検定', '3級'),
  unconfirmed('business-accounting-3', 'ビジネス会計検定', '3級'),
  unconfirmed('info-sec-mgmt', '情報セキュリティマネジメント'),
  unconfirmed('color-3', '色彩検定', '3級'),
  unconfirmed('sekaken-3', '世界遺産検定', '3級'),
  unconfirmed('eco', 'eco検定'),
  {
    id: 'fp-3',
    name: 'FP技能検定',
    grade: '3級',
    domains: [
      { id: 'life-planning', name: 'ライフプランニングと資金計画' },
      { id: 'risk', name: 'リスク管理' },
      { id: 'financial-assets', name: '金融資産運用' },
      { id: 'tax', name: 'タックスプランニング' },
      { id: 'real-estate', name: '不動産' },
      { id: 'inheritance', name: '相続・事業承継' },
    ],
    domainsConfirmed: false, // 公式資料での再確認は今回未実施
    contentStatus: 'not_authored',
  },
];

export const THEMES: Theme[] = [
  { qualificationId: 'it-passport', id: 'bit-patterns', domainId: 'technology', title: 'ビット列の組合せ数' },
];

/** 学習記録の鍵。資格が増えても混ざらない */
export const themeKey = (qualificationId: string, themeId: string) => `${qualificationId}/${themeId}`;

export function findQualification(id: string): Qualification | undefined {
  return QUALIFICATIONS.find((q) => q.id === id);
}

export function findTheme(qualificationId: string, themeId: string): Theme | undefined {
  return THEMES.find((t) => t.qualificationId === qualificationId && t.id === themeId);
}
