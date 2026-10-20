import { useState, type ReactNode } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { QUALIFICATIONS, type AnswerMode, type GardenSnapshot } from '../../../src/mobile.ts';
import { QUAL_ID } from '../state/controller';
import { themesOf } from '../state/learningPack';
import type { QualSummary } from '../state/diagnosticController';
import { validateEntry, type NotebookEntry, type Settings } from '../state/notebook';
import { CHARACTERS, characterName, type CharacterId } from '../state/characters';
import { SLOT_COUNT, type Roster } from '../state/roster';
import { SEED_IMAGES } from './characterAssets';
import { charMotion } from './motionCatalog';
import { SHOP_ITEMS, ownedSet } from '../state/furniture';
import { FURNITURE_IMAGES } from './furnitureAssets';
import { Body, Button, Card, H } from './common';
import { formatDate } from './Home';
import { C, MAX_W, T } from './theme';

const pad = { padding: 14, gap: 12 } as const;

const qualName = (id: string) => {
  const q = QUALIFICATIONS.find((x) => x.id === id);
  return q ? `${q.name}${q.grade ? ` ${q.grade}` : ''}` : id;
};

interface NotebookProps {
  entries: NotebookEntry[];
  error: string | null;
  settings: Settings;
  onSave: (entries: NotebookEntry[]) => Promise<boolean>;
  onSettings: (s: Settings) => void;
  /** 資格別の学習時間・完了テーマ・次の復習を、結び付けた記録に見せるため */
  snapshot: GardenSnapshot | null;
  /** 浮いたタブ・ホームバーに隠れないよう、内容の末尾に足す余白（iOS候補用。既定0） */
  bottomInset?: number;
  /** せっていの下に足す部品（iOS候補のアカウント）。本体では渡さない */
  footer?: ReactNode;
}

const qualLabel = (id: string) => {
  const q = QUALIFICATIONS.find((x) => x.id === id);
  return q ? `${q.name}${q.grade ? ` ${q.grade}` : ''}` : id;
};

export function NotebookTab({ entries, error, settings, onSave, onSettings, snapshot, bottomInset = 0, footer }: NotebookProps) {
  const padStyle = bottomInset ? { ...pad, paddingBottom: pad.padding + bottomInset } : pad;
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [memo, setMemo] = useState('');
  const [qualId, setQualId] = useState<string | undefined>(undefined);
  const [passed, setPassed] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const open = (e: NotebookEntry | null) => {
    setEditing(e ? e.id : 'new');
    setName(e?.name ?? '');
    setDate(e?.date ?? '');
    setMemo(e?.memo ?? '');
    setQualId(e?.qualificationId);
    setPassed(e?.passed === true);
    setFormError(null);
  };
  const submit = async () => {
    const problem = validateEntry(name, date);
    if (problem) return setFormError(problem);
    const entry: NotebookEntry = {
      id: editing === 'new' || editing === null ? `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}` : editing,
      name: name.trim(), date: date.trim(), memo: memo.trim(),
      ...(qualId ? { qualificationId: qualId } : {}),
      ...(passed ? { passed: true } : {}),
    };
    const nextEntries = editing === 'new' ? [...entries, entry] : entries.map((x) => (x.id === editing ? entry : x));
    if (await onSave(nextEntries)) setEditing(null);
  };
  const remove = async (id: string) => {
    if (await onSave(entries.filter((x) => x.id !== id))) setConfirmDelete(null);
  };

  return (
    <ScrollView contentContainerStyle={padStyle} keyboardShouldPersistTaps="handled">
      <H>手帳</H>
      <Body sub>自分で書きとめる取得資格の記録です。公式の合格証明ではありません。</Body>
      {error ? <Card><Body>手帳のデータを読めないため、いまは編集できません（データは消していません）。</Body></Card> : null}
      {entries.length === 0 && !error ? <Body sub>まだ記録がありません。</Body> : null}
      {entries.some((e) => e.passed) ? (
        <Card>
          <H>自分の記録のバッジ</H>
          <View style={styles.badgeRow}>
            {entries.filter((e) => e.passed).map((e) => (
              <Text key={e.id} style={styles.badge} accessibilityLabel={`${e.name}、取得（自分の記録）`}>🍃 {e.name}</Text>
            ))}
          </View>
          <Body sub>自分で「取得した」と記録したものだけです。公式の証明ではなく、アプリが合否を判定したものでもありません。ほかの人には見えません。</Body>
        </Card>
      ) : null}
      {entries.map((e) => (
        <Card key={e.id}>
          <Text style={styles.qName}>{e.name}</Text>
          {e.passed ? <Text style={styles.badge}>自分の記録：取得</Text> : null}
          {e.date ? <Body sub>取得日 {e.date}</Body> : null}
          {e.memo ? <Body>{e.memo}</Body> : null}
          {e.qualificationId && snapshot ? (
            <View accessibilityLabel={`${qualLabel(e.qualificationId)}の学習のようす`}>
              <Body sub>
                学習の記録（{qualLabel(e.qualificationId)}）: 学習時間 {Math.floor((snapshot.studySeconds[e.qualificationId] ?? 0) / 60)}分／
                完了した基礎テーマ {themesOf(e.qualificationId).filter((t) => snapshot.completedThemes.includes(`${t.qualificationId}/${t.themeId}`)).length}/{themesOf(e.qualificationId).length}／
                次のおさらい {(() => {
                  const n = snapshot.nextReviews.filter((r) => r.qualificationId === e.qualificationId).sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0];
                  return n ? formatDate(n.dueDate) : 'まだありません';
                })()}
              </Body>
            </View>
          ) : null}
          {confirmDelete === e.id ? (
            <View style={{ gap: 8 }}>
              <Body>この記録を削除しますか？ もとに戻せません。</Body>
              <View style={styles.row}>
                <Button label="削除する" onPress={() => void remove(e.id)} style={{ flex: 1 }} />
                <Button label="やめる" kind="secondary" onPress={() => setConfirmDelete(null)} style={{ flex: 1 }} />
              </View>
            </View>
          ) : (
            <View style={styles.row}>
              <Button label="編集" kind="secondary" onPress={() => open(e)} disabled={!!error} style={{ flex: 1 }} />
              <Button label="削除" kind="secondary" onPress={() => setConfirmDelete(e.id)} disabled={!!error} style={{ flex: 1 }} />
            </View>
          )}
        </Card>
      ))}
      {editing ? (
        <Card>
          <H>{editing === 'new' ? '記録を追加' : '記録を編集'}</H>
          <Text style={styles.label}>資格の名前</Text>
          <TextInput value={name} onChangeText={setName} style={styles.input} placeholder="例: ITパスポート" accessibilityLabel="資格の名前" />
          <Text style={styles.label}>学習中の資格に結び付ける（任意）</Text>
          <View style={styles.badgeRow} accessibilityRole="radiogroup">
            {[{ id: undefined as string | undefined, label: '結び付けない' }, ...QUALIFICATIONS.map((q) => ({ id: q.id as string | undefined, label: qualLabel(q.id) }))].map((o) => {
              const on = qualId === o.id;
              return (
                <Pressable
                  key={o.id ?? 'none'}
                  onPress={() => { setQualId(o.id); if (o.id && name.trim() === '') setName(o.label); }}
                  role="radio"
                  aria-checked={on}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${o.label}${on ? '、選択中' : ''}`}
                  style={[styles.pick, on ? styles.pickOn : styles.pickOff, { height: 44, paddingHorizontal: 10 }]}
                >
                  <Text style={[styles.pickText, on && { color: C.accentText }]}>{o.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Pressable
            onPress={() => setPassed(!passed)}
            role="checkbox"
            aria-checked={passed}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: passed }}
            accessibilityLabel="取得した（自分の記録）"
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <Text style={styles.pickText}>{passed ? '☑' : '☐'} 取得した（自分の記録。公式の証明ではありません）</Text>
          </Pressable>
          <Text style={styles.label}>取得日（わかれば）</Text>
          <TextInput value={date} onChangeText={setDate} style={styles.input} placeholder="2026-10-12" accessibilityLabel="取得日" autoCapitalize="none" />
          <Text style={styles.label}>メモ</Text>
          <TextInput value={memo} onChangeText={setMemo} style={[styles.input, { minHeight: 72 }]} multiline accessibilityLabel="メモ" />
          {formError ? <Text style={styles.err} accessibilityLiveRegion="polite">{formError}</Text> : null}
          <View style={styles.row}>
            <Button label="保存する" onPress={() => void submit()} style={{ flex: 1 }} />
            <Button label="やめる" kind="secondary" onPress={() => setEditing(null)} style={{ flex: 1 }} />
          </View>
        </Card>
      ) : (
        <Button label="記録を追加" onPress={() => open(null)} disabled={!!error} />
      )}
      <Card>
        <H>せってい</H>
        <View style={styles.switchRow}>
          <Text style={[styles.qName, { flex: 1 }]}>動きを減らす</Text>
          <Switch value={settings.reduceMotion} onValueChange={(v) => onSettings({ ...settings, reduceMotion: v })} accessibilityLabel="動きを減らす" />
        </View>
        <Body sub>相棒の連番アニメと切り替えの動きを止めます。端末の「動きを減らす」設定も反映されます。</Body>
      </Card>
      {footer}
    </ScrollView>
  );
}

interface ShopProps {
  roster: Roster;
  snapshot: GardenSnapshot | null;
  busy: boolean;
  onSlot: (slot: number, id: CharacterId) => void;
  onCompanion: (id: CharacterId) => void;
  onBuy: (furnitureId: string) => void;
  bottomInset?: number;
}

export function ShopTab({ roster, snapshot: snap, busy, onSlot, onCompanion, onBuy, bottomInset = 0 }: ShopProps) {
  const padStyle = bottomInset ? { ...pad, paddingBottom: pad.padding + bottomInset } : pad;
  const { width } = useWindowDimensions();
  const snapshot = snap ?? { points: 0, ownedFurniture: [] as string[] };
  const owned = ownedSet(snapshot.ownedFurniture);
  // 箱庭の3枠のどれに入れるか。タップした枠が対象（別の枠にいる子を選ぶと入れ替わる）
  const [slot, setSlot] = useState(0);
  const cols = 3;
  const cell = Math.floor((Math.min(width, MAX_W) - 28 - 32 - (cols - 1) * 8) / cols);
  return (
    <ScrollView contentContainerStyle={padStyle}>
      <H>お店</H>
      <Body sub>この試作では、購入や課金はできません。全26匹は体験用にいつでもえらべます（購入や所有の確定ではありません）。</Body>
      <Card>
        <H>箱庭の{SLOT_COUNT}枠</H>
        <Body sub>入れかえたい枠をえらんでから、下の一覧で子をえらびます。</Body>
        <View style={styles.row} accessibilityRole="radiogroup">
          {roster.room.map((id, i) => {
            const on = slot === i;
            return (
              <Pressable
                key={i}
                onPress={() => setSlot(i)}
                role="radio"
                aria-checked={on}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${i + 1}つめの枠、${characterName(id)}${on ? '、対象' : ''}`}
                style={[styles.pick, on ? styles.pickOn : styles.pickOff, { flex: 1, height: 56 }]}
              >
                <Text style={[styles.pickText, on && { color: C.accentText }]} numberOfLines={2}>{i + 1}. {characterName(id)}</Text>
              </Pressable>
            );
          })}
        </View>
      </Card>
      <Card>
        <H>相棒をえらぶ（無料）</H>
        <Body sub>
          枠に入れる子と、学習中に机にいる子をえらべます。全員、箱庭で待機したり、左右へすすんだりします（動きの絵は確認中の候補です）。
        </Body>
        <View style={[styles.row, { flexWrap: 'wrap' }]}>
          {CHARACTERS.map((ch) => {
            const inSlot = roster.room.indexOf(ch.id);
            const isCompanion = roster.companion === ch.id;
            const moves = !!charMotion(ch.id);
            return (
              <View key={ch.id} style={{ width: cell, gap: 4, alignItems: 'center', marginBottom: 8 }}>
                <Image source={SEED_IMAGES[ch.id]} resizeMode="contain" style={{ width: cell * 0.8, height: cell * 0.8 }} accessibilityLabel={ch.name} />
                <Text style={styles.cName} numberOfLines={2}>{ch.name}</Text>
                <Text style={styles.soon}>{moves ? '待機・移動' : '静止'}</Text>
                <Pressable
                  onPress={() => onSlot(slot, ch.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${ch.name}を${slot + 1}つめの枠に${inSlot === slot ? '、すでに入っています' : '入れる'}`}
                  accessibilityState={{ selected: inSlot === slot }}
                  style={[styles.pick, inSlot >= 0 ? styles.pickOn : styles.pickOff, { height: 44 }]}
                >
                  <Text style={[styles.pickText, inSlot >= 0 && { color: C.accentText }]}>{inSlot >= 0 ? `✓ 枠${inSlot + 1}` : '枠に入れる'}</Text>
                </Pressable>
                <Pressable
                  onPress={() => onCompanion(ch.id)}
                  accessibilityRole="button"
                  accessibilityLabel={`${ch.name}、学習の相棒に${isCompanion ? '、えらび中' : 'する'}`}
                  accessibilityState={{ selected: isCompanion }}
                  style={[styles.pick, isCompanion ? styles.pickOn : styles.pickOff, { height: 44 }]}
                >
                  <Text style={[styles.pickText, isCompanion && { color: C.accentText }]}>{isCompanion ? '✓ 学習の相棒' : '学習の相棒に'}</Text>
                </Pressable>
              </View>
            );
          })}
        </View>
      </Card>
      <Card>
        <H>家具（ためしのポイントで）</H>
        <Body sub>
          いまのポイント: {snapshot.points}。ここで使うのは学習でためる、この試作だけの仮ポイントです。お金の価格ではなく、購入や課金はありません。同じ家具は1つまで。
        </Body>
        {SHOP_ITEMS.map((f) => {
          const have = owned.has(f.id);
          const short = !have && snapshot.points < f.trialPointCost;
          return (
            <View key={f.id} style={styles.themeRow}>
              <Image source={FURNITURE_IMAGES[f.id]} resizeMode="contain" style={{ width: 56, height: 56 }} accessibilityLabel={f.name} />
              {/* 説明は最低160の幅を確保する。狭い幅・大きな文字では入手ボタンが次の行へ回り、説明が細切れにならない（広い幅は従来の1行） */}
              <View style={{ flexGrow: 1, flexShrink: 1, flexBasis: 160 }}>
                <Text style={styles.cName}>{f.name}</Text>
                <Body sub>{have ? '持っています（おへやの「模様替え」で置けます）' : `${f.trialPointCost}ポイント${short ? '（足りません）' : ''}`}</Body>
              </View>
              <Button
                label={have ? '持っている' : '入手する'}
                kind={have ? 'secondary' : 'primary'}
                onPress={() => onBuy(f.id)}
                disabled={have || short || busy}
                hint={have ? 'すでに持っています' : short ? 'ポイントが足りません' : undefined}
              />
            </View>
          );
        })}
      </Card>
      <Card>
        <H>模様替え</H>
        <Body sub>箱庭の「おへや」で「模様替え」を押すと、持っている家具を選んで動かしたり、しまったりできます。はじめの3点（ラグ・知恵の木・スツール）は最初から持っています。</Body>
        <Body sub>衣装や課金の商品は、まだ作っていません。</Body>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  qName: { ...T.head, fontSize: 17, lineHeight: 24, color: C.ink },
  badgeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  badge: { ...T.head, alignSelf: 'flex-start', fontSize: 14, lineHeight: 20, color: C.accentDark, backgroundColor: C.okBg, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeChip: { flex: 1, minHeight: 48, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  qChip: { minHeight: 56, minWidth: 96, flexGrow: 1, borderRadius: 16, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8, paddingVertical: 6 },
  qSub: { ...T.head, fontSize: 12, lineHeight: 17, color: C.sub },
  themeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, paddingVertical: 6 },
  soon: { ...T.head, alignSelf: 'flex-start', fontSize: 13, lineHeight: 19, color: C.sub, borderWidth: 1.5, borderColor: C.line, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  row: { flexDirection: 'row', gap: 8 },
  cName: { ...T.head, fontSize: 14, lineHeight: 20, color: C.ink, textAlign: 'center' },
  pick: { alignSelf: 'stretch', height: 48, borderRadius: 18, borderWidth: 2, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  pickOn: { backgroundColor: C.accent, borderColor: C.accentDark },
  pickOff: { backgroundColor: C.card, borderColor: C.line },
  pickText: { ...T.button, fontSize: 15, lineHeight: 22, color: C.ink },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48 },
  label: { ...T.head, fontSize: 13, lineHeight: 19, color: C.sub },
  input: { minHeight: 48, borderWidth: 2, borderColor: C.line, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8, ...T.body, fontSize: 16, backgroundColor: '#fff', color: C.ink },
  err: { ...T.head, color: C.warn },
});
