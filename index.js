const {
  Client,
  GatewayIntentBits,
  Collection,
  Events,
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  UserSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");
const fs = require("fs");
const mongoose = require("mongoose");
const https = require("https");

// ─── 環境変数と基本設定 ────────────────────────────────────────────────────────
const token = process.env.DISCORD_TOKEN;
const mongoUri = process.env.MONGO_URI;
if (!token) { console.error("❌ 環境変数 DISCORD_TOKEN が設定されていません。"); process.exit(1); }
if (!mongoUri) { console.warn("⚠️ MONGO_URI が設定されていません。ローカルDBを使用します。"); }

const { clientId, guildId } = require("./config.json");
const allCommands = require("./commands");

// ─── MongoDB スキーマ定義 ──────────────────────────────────────────────────────
const guildSchema = new mongoose.Schema({
  guildId: { type: String, required: true, unique: true },
  dynamicVC: { type: Object, default: {} },
  roles: { type: Object, default: {} },
  features: { type: Object, default: {} },
  meta: { type: Object, default: { version: 1, lastUpdated: new Date().toISOString() } },
  messages: { type: Object, default: {} }
});

const introSchema = new mongoose.Schema({
  guildId: { type: String, required: true },
  userId: { type: String, required: true },
  introduced: { type: Boolean, default: false },
  content: { type: String, default: "" },
  warnMsgId: { type: String, default: null },
  warned: { type: Boolean, default: false },
  kicked: { type: Boolean, default: false }
});
introSchema.index({ guildId: 1, userId: 1 }, { unique: true });

const Guild = mongoose.model("Guild", guildSchema);
const Intro = mongoose.model("Intro", introSchema);

// ─── DB接続 ──────────────────────────────────────────────────────────────────
mongoose.connect(mongoUri || "mongodb://localhost:27017/discordbot")
  .then(() => console.log("🍃 MongoDB 接続完了"))
  .catch(err => console.error("❌ MongoDB 接続エラー:", err));

// ─── グローバル変数と初期化 ────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,
  ],
});
client.commands = new Collection();
for (const cmd of allCommands) {
  client.commands.set(cmd.data.name, cmd);
}

// レート制限などのエラーでプロセスが終了しないようにハンドリング
client.on(Events.Error, err => console.error("❌ Discord Client Error:", err));
process.on("unhandledRejection", err => console.error("❌ Unhandled Rejection:", err));
process.on("uncaughtException", err => console.error("❌ Uncaught Exception:", err));

const defaultMessages = {
  "introNotify": "✅ <@{user}> さんの自己紹介を確認しました！",
  "limitLockedWarning": "⚠️ この部屋は作成時に人数が固定されているため、変更できません。",
  "genderMaleOnlyDM": "🚫 {vcName} は ♂️ 男性専用 VCのため入室できません。",
  "genderFemaleOnlyDM": "🚫 {vcName} は ♀️ 女性専用 VCのため入室できません。",
  "introWarnMsg": "⚠️ <@{user}> さん、自己紹介の提出期限が迫っています。\\nあと **{leftMinutes}分** 以内にこのチャンネルに自己紹介を記入しないと、自動的に退出となりますのでご注意ください！",
  "introKickDM": "サーバー参加後、指定された期間内に自己紹介の記入がなかったため、サーバーから自動退出となりました。"
};

const tempChannels = new Set(), controlPanelMsgIds = new Map(), vcOwners = new Map(), lockedVCs = new Set(), genderMode = new Map(), pendingRequests = new Map(), allowedUsers = new Map(), knockNotifyMsgIds = new Map(), introPosted = new Map(), introMsgIds = new Map(), limitLockedVCs = new Set(), privateVCs = new Set(), renameTimestamps = new Map();
const guildCache = new Map();
const recruitSelections = new Map();
// 外部読み上げBOT呼び込み状態管理
const activeTTSBots = new Map();

// ─── データ管理ユーティリティ ──────────────────────────────────────────────────
const defaultFeatures = {
  afkEnabled: false,
  vcPanelEnabled: false,
  vcCreationEnabled: false,
  introKickEnabled: false,
  vcIntroDisplayEnabled: false,
  genderRoleEnabled: false,
  memberCountEnabled: false,
  msgRelayEnabled: false
};

const defaultDynamicVC = {
  channelName: "{user}のVC",
  channelName4: "雑談4人部屋",
  channelName5: "雑談5人部屋",
  introWarnMinutes: 2880,
  introKickMinutes: 4320,
  autoDeleteMinutes: 5,
  vcSlots: [] // 動的VCスロット [{name, limit, triggerChannelId, locked?}]
};

async function getGuildConfig(gid, forceRefresh = false) {
  if (!forceRefresh && guildCache.has(gid)) return guildCache.get(gid);

  let g = await Guild.findOne({ guildId: gid });

  // 既存データがない、または機能設定が完全に空の場合に移行/初期化を試みる
  const isNewOrEmpty = !g || (!g.features || Object.keys(g.features).length === 0);

  if (isNewOrEmpty && gid === guildId) {
    try {
      const local = require("./config.json");
      const msgs = fs.existsSync("./messages.json") ? JSON.parse(fs.readFileSync("./messages.json", "utf-8")) : defaultMessages;

      const initialData = {
        guildId: gid,
        dynamicVC: { ...defaultDynamicVC, ...local.dynamicVC },
        roles: local.roles || {},
        features: { ...defaultFeatures, ...local.features },
        messages: msgs
      };

      if (!g) {
        g = await Guild.create(initialData);
        console.log(`📦 Guild ${gid}: 初期データを config.json からインポートしました。`);
      } else {
        await Guild.updateOne({ guildId: gid }, { $set: initialData });
        g = await Guild.findOne({ guildId: gid });
        console.log(`📦 Guild ${gid}: 既存の空データを config.json の内容で更新しました。`);
      }
    } catch (err) {
      console.error("❌ 初期データ移行エラー:", err);
    }
  }

  if (!g) {
    g = await Guild.create({
      guildId: gid,
      dynamicVC: defaultDynamicVC,
      features: defaultFeatures,
      messages: defaultMessages
    });
  }
  guildCache.set(gid, g);
  return g;
}

async function updateGuildConfig(gid, data) {
  await Guild.updateOne({ guildId: gid }, data);
  guildCache.delete(gid); // キャッシュ破棄
}

async function updateIntro(gid, uid, data) {
  return await Intro.findOneAndUpdate({ guildId: gid, userId: uid }, { $set: data }, { upsert: true, new: true });
}

// ─── UIヘルパー ──────────────────────────────────────────────────────────────
const createBtn = (id, label, style = ButtonStyle.Secondary, disabled = false) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
const createRow = (components) => new ActionRowBuilder().addComponents(components);
const silentReply = async (i) => { try { await i.reply({ content: "\u200B" }); await i.deleteReply(); } catch { } };

// ─── 設定パネル用ペイロード生成 ──────────────────────────────────────
async function getSettingsPayload(gid, type = "main", config = null) {
  const doc = config || await getGuildConfig(gid);
  const g = doc.toObject ? doc.toObject() : doc;
  const dynamicVC = g.dynamicVC || {};
  const roles = g.roles || {};
  const features = { ...defaultFeatures, ...(g.features || {}) };
  const messages = g.messages || {};

  const guild = client.guilds.cache.get(gid);
  const guildName = guild ? guild.name : "Unknown Server";

  const on = "●", off = "○";
  const fStatus = (feat) => features[feat] ? "🟢 有効" : "🔴 無効";
  let embed = new EmbedBuilder().setColor(0x2b2d31);
  let components = [];

  if (type === "main") {
    embed.setTitle(null).setDescription(`# ${guildName}\n-# v1.2.0 (Multi-Guild Mode)\n\n### ⚙️ 設定カテゴリを選択してください\n各カテゴリーから、機能の有効化やチャンネル・ロールの詳細設定が行えます。`);
    components = [
      createRow([createBtn("cfg_btn_ch_features", "📺 チャンネル機能", ButtonStyle.Primary), createBtn("cfg_btn_vc_features", "🎙️ VC内機能", ButtonStyle.Primary)]),
      createRow([createBtn("config_messages", "💬 メッセージ編集", ButtonStyle.Secondary)])
    ];
  } else if (type === "msg_relay") {
    const isEnabled = features.msgRelayEnabled;
    let subDesc = "### 📨 メッセージ転送設定\n指定チャンネルの投稿を別チャンネルへ自動転送します。\n省略文字列を設定すると、その文字列以降は送信されません。\n\n";
    subDesc += `**状態**: [ ${fStatus("msgRelayEnabled")} ]\n`;
    subDesc += `**📥 転送元**: ${dynamicVC.msgRelaySourceChannelId ? `<#${dynamicVC.msgRelaySourceChannelId}>` : "`未設定` 🟥"}\n`;
    subDesc += `**📤 転送先**: ${dynamicVC.msgRelayDestChannelId ? `<#${dynamicVC.msgRelayDestChannelId}>` : "`未設定` 🟥"}\n`;
    subDesc += `**⚠️ 報告通知先**: ${dynamicVC.msgRelayReportUserId ? `<@${dynamicVC.msgRelayReportUserId}>` : "`未設定` (未設定時はオーナーにDM)"}\n`;
    subDesc += `**✂️ 省略文字列**: ${dynamicVC.msgRelayCutoff ? `\`${dynamicVC.msgRelayCutoff}\`` : "`未設定` (全文転送)"}\n\n`;
    subDesc += `-# 省略文字列が含まれる行から下は転送されません。投稿者のアイコン・名前付きで転送されます。`;
    embed.setTitle(null).setDescription(subDesc);
    components = [
      createRow([createBtn("toggle_msg_relay", `転送: ${isEnabled ? "有効" : "無効"}`, isEnabled ? ButtonStyle.Success : ButtonStyle.Danger), createBtn("cfg_msg_relay_cutoff", "✂️ 省略文字列", ButtonStyle.Secondary, !isEnabled)]),
      createRow([new ChannelSelectMenuBuilder().setCustomId("select_cfg_relay_src").setPlaceholder(isEnabled ? "📥 転送元チャンネルを選択" : "⛔ 無効なため設定不可").setChannelTypes([ChannelType.GuildText]).setDisabled(!isEnabled)]),
      createRow([new ChannelSelectMenuBuilder().setCustomId("select_cfg_relay_dst").setPlaceholder(isEnabled ? "📤 転送先チャンネルを選択" : "⛔ 無効なため設定不可").setChannelTypes([ChannelType.GuildText]).setDisabled(!isEnabled)]),
      createRow([new UserSelectMenuBuilder().setCustomId("select_cfg_relay_rpt").setPlaceholder(isEnabled ? "⚠️ 報告通知先ユーザーを選択 (任意)" : "⛔ 無効なため設定不可").setDisabled(!isEnabled)]),
      createRow([createBtn("cfg_btn_ch_features", "⬅️ 戻る")])
    ];
  } else if (type === "member_count") {
    const fmt = dynamicVC.memberCountFormat || "♂ {male}人・♀ {female}人・👤 {total}人";
    const previewName = fmt.replace("{male}", "39").replace("{female}", "52").replace("{total}", "91");
    let subDesc = "### 👥 人数カウンター設定\n1つのボイスチャンネルに男性・女性・合計人数を横並びで表示します。\n\n";
    subDesc += `**状態**: [ ${fStatus("memberCountEnabled")} ]\n`;
    subDesc += `**📍 表示チャンネル**: ${dynamicVC.memberCountChannelId ? `<#${dynamicVC.memberCountChannelId}>` : "`未設定` 🟥"}\n`;
    subDesc += `**📝 表示形式**: \`${fmt}\`\n`;
    subDesc += `**🔍 プレビュー**: \`${previewName}\`\n\n`;
    subDesc += `-# \`{male}\`=男性数 / \`{female}\`=女性数 / \`{total}\`=合計数 で要のチャンネル名に使えます。`;
    embed.setTitle(null).setDescription(subDesc);
    const isEnabled = features.memberCountEnabled;
    components = [
      createRow([createBtn("toggle_member_count", `カウンター: ${isEnabled ? "有効" : "無効"}`, isEnabled ? ButtonStyle.Success : ButtonStyle.Danger), createBtn("cfg_member_count_update", "🔄 今すぐ更新", ButtonStyle.Secondary, !isEnabled), createBtn("cfg_member_count_format", "📝 表示形式編集", ButtonStyle.Secondary, !isEnabled), createBtn("cfg_member_count_details", "📋 詳細確認", ButtonStyle.Secondary, !isEnabled)]),
      createRow([new ChannelSelectMenuBuilder().setCustomId("select_cfg_mc_main").setPlaceholder(isEnabled ? "📍 カウンター表示チャンネルを選択" : "⛔ 無効なため設定不可").setChannelTypes([ChannelType.GuildVoice]).setDisabled(!isEnabled)]),
      createRow([createBtn("cfg_btn_ch_features", "⬅️ 戻る")])
    ];
  } else if (type === "ch_features") {
    let subDesc = "### 📺 チャンネル機能設定\nボットの根幹となるチャンネル関連の機能設定です。\n\n";
    subDesc += `**🎫 VC作成チャンネル** [ ${fStatus("vcPanelEnabled")} ]\n┕ 設置先: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定` 🟥"}\n\n`;
    subDesc += `**➕ ＶＣチャンネル自動作成** [ ${fStatus("vcCreationEnabled")} ]\n┕ 自由枠: ${dynamicVC.triggerChannelId ? `<#${dynamicVC.triggerChannelId}>` : "`未設定` 🟥"}\n\n`;
    subDesc += `**🛂 入国審査 (自動整理)** [ ${fStatus("introKickEnabled")} ]\n┕ 提出確認: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定` 🟥"}\n\n`;
    subDesc += `**⏱️ 空室削除タイマー**: ${dynamicVC.autoDeleteMinutes || 5}分\n\n`;
    subDesc += `**👥 人数カウンター**: [ ${fStatus("memberCountEnabled")} ]\n`;
    subDesc += `**📨 メッセージ転送**: [ ${fStatus("msgRelayEnabled")} ]\n`;
    embed.setTitle(null).setDescription(subDesc);
    components = [
      createRow([createBtn("cfg_btn_panel", "🎫 作成パネル", ButtonStyle.Secondary), createBtn("cfg_btn_trigger", "➕ 自動作成", ButtonStyle.Secondary), createBtn("cfg_btn_intro_kick", "🛂 入国審査", ButtonStyle.Secondary)]),
      createRow([createBtn("cfg_btn_member_count", "👥 人数カウンター", ButtonStyle.Secondary), createBtn("cfg_btn_msg_relay", "📨 メッセージ転送", ButtonStyle.Secondary), createBtn("cfg_btn_auto_delete", "⏱️ 削除設定", ButtonStyle.Secondary)]),
      createRow([createBtn("cfg_back_main", "⬅️ 戻る")])
    ];

  } else if (type === "vc_features") {
    const bStyle = (feat) => features[feat] ? ButtonStyle.Secondary : ButtonStyle.Danger;
    let subDesc = "### 🎙️ VC内機能設定\n各機能の詳細設定や有効化・無効化が行えます。\n\n";
    subDesc += `**💤 AFK (寝落ち)** [ ${fStatus("afkEnabled")} ]\n┕ 移動先: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定` 🟥"}\n\n`;
    subDesc += `**🖼️ 自己紹介表示** [ ${fStatus("vcIntroDisplayEnabled")} ]\n┕ ソース: ${dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定` 🟥"}\n\n`;
    subDesc += `**🚻 部屋制限** [ ${fStatus("genderRoleEnabled")} ]\n┕ ♂️ ${roles.male ? `<@&${roles.male}>` : "`未設定` 🟥"}\n┕ ♀️ ${roles.female ? `<@&${roles.female}>` : "`未設定` 🟥"}\n\n`;
    embed.setTitle(null).setDescription(subDesc);
    components = [
      createRow([createBtn("cfg_btn_afk", "💤 AFK", bStyle("afkEnabled")), createBtn("cfg_btn_intro_display", "🖼️ 紹介表示", bStyle("vcIntroDisplayEnabled")), createBtn("cfg_btn_vc", "🚻 部屋制限", bStyle("genderRoleEnabled"))]),
      createRow([createBtn("cfg_btn_recruit", "📢 募集機能", bStyle("recruitEnabled")), createBtn("cfg_back_main", "⬅️ 戻る")])
    ];
  } else {
    const configs = {
      afk: { title: "💤 AFK (寝落ち) 設定", desc: `- 💤 移動先: ${dynamicVC.afkChannelId ? `<#${dynamicVC.afkChannelId}>` : "`未設定`"}\n\n一定時間動きがないユーザーを自動的にAFKチャンネルへ移動させます。`, feature: "afkEnabled", toggle: "toggle_afk", label: "AFK機能", select: { id: "select_cfg_afk", ph: "💤 移動先を選択", type: [ChannelType.GuildVoice] }, back: "vc_features" },
      panel: { title: "🎫 VC作成チャンネル設定", desc: `- 🎫 設置先: ${dynamicVC.createPanelChannelId ? `<#${dynamicVC.createPanelChannelId}>` : "`未設定`"}\n- 📂 作成先カテゴリ: ${dynamicVC.cleanupCategoryId ? `<#${dynamicVC.cleanupCategoryId}>` : "`未設定`"}\n\nボタンを押して新しいVCを作成できるパネルを設置します。`, feature: "vcPanelEnabled", toggle: "toggle_panel", label: "作成パネル", selects: [{ id: "select_cfg_panel", ph: "🎫 設置先を選択", type: [ChannelType.GuildText] }, { id: "select_cfg_category", ph: "📂 作成先カテゴリを選択", type: [ChannelType.GuildCategory] }], back: "ch_features" },
      trigger: {
        title: "➕ ＶＣチャンネル自動作成 設定",
        desc: buildTriggerDesc(dynamicVC, client.guilds.cache.get(gid)),
        feature: "vcCreationEnabled", toggle: "toggle_vc_creation", label: "自動作成",
        extraBtn: createBtn("cfg_trigger_add_slot", "➕ スロット追加", ButtonStyle.Primary),
        back: "ch_features"
      },
      intro_kick: { title: "🛂 入国審査 (自動整理) 設定", desc: `- 🛂 提出確認: ${dynamicVC.introCheckChannelId ? `<#${dynamicVC.introCheckChannelId}>` : "`未設定`"}\n- ⚠️ 警告: ${dynamicVC.introWarnMinutes || 2880}分後\n- 🚪 キック: ${dynamicVC.introKickMinutes || 4320}分後\n\n参加後に自己紹介を記入しなかったユーザーを自動的にサーバーから退場させます。`, feature: "introKickEnabled", toggle: "toggle_intro_kick", label: "入国審査", extraBtn: createBtn("config_intro_time", "⏱️ 期限設定", ButtonStyle.Primary), extraBtn2: createBtn("cfg_intro_restore", "🔄 チャンネルから復元", ButtonStyle.Secondary), extraBtn3: createBtn("cfg_intro_list", "📋 承認済みリスト", ButtonStyle.Secondary), extraBtn4: createBtn("cfg_intro_sync_all", "👥 全員を承認", ButtonStyle.Danger), selects: [{ id: "select_cfg_introcheck", ph: "🛂 提出確認先を選択", type: [ChannelType.GuildText] }, { id: "select_cfg_intro_add", ph: "👤 手動で承認ユーザーを追加", user: true, multi: true }], back: "ch_features" },
      intro_display: { title: "🖼️ VC内自己紹介表示 設定", desc: `- 📋 ソース: ${dynamicVC.introSourceChannelIds?.length > 0 ? dynamicVC.introSourceChannelIds.map(id => `<#${id}>`).join(", ") : (dynamicVC.introSourceChannelId ? `<#${dynamicVC.introSourceChannelId}>` : "`未設定` 🟥")}\n\nVCに入室したユーザーの自己紹介を自動的にテキストチャンネルへ表示します。`, feature: "vcIntroDisplayEnabled", toggle: "toggle_vc_intro", label: "VC内表示", extraBtn: createBtn("cfg_intro_restore", "🔄 チャンネルから復元", ButtonStyle.Secondary), select: { id: "select_cfg_introsource", ph: "📋 ソースを選択 (複数可)", type: [ChannelType.GuildText], multi: true }, back: "vc_features" },
      vc: {
        title: "🚻 部屋制限 設定", desc: `- ♂️ 男性ロール: ${roles.male ? `<@&${roles.male}>` : "`未設定`"}\n- ♀️ 女性ロール: ${roles.female ? `<@&${roles.female}>` : "`未設定`"}\n\nVCオーナーが部屋のロックや性別制限を行えるようにします。`, feature: "genderRoleEnabled", toggle: "toggle_gender", label: "部屋制限",
        extraBtn: createBtn("config_roles_id", "🆔 IDで設定", ButtonStyle.Primary),
        selects: [
          { id: "select_cfg_male", ph: "♂️ 男性ロールを選択", role: true },
          { id: "select_cfg_female", ph: "♀️ 女性ロールを選択", role: true }
        ], back: "vc_features"
      },
      recruit: {
        title: "📢 メンバー募集設定",
        desc: `- 📢 募集板: ${dynamicVC.recruitmentChannelId ? `<#${dynamicVC.recruitmentChannelId}>` : "`未設定`"}\n- 🔔 募集ロール: ${(dynamicVC.recruitmentRoleIds?.length > 0) ? dynamicVC.recruitmentRoleIds.map(id => `<@&${id}>`).join(" ") : (dynamicVC.recruitmentRoleId ? `<@&${dynamicVC.recruitmentRoleId}>` : "`未設定`")}\n- 📝 初期値: \`${dynamicVC.defaultRecruitContent || "雑談"}\` / \`${dynamicVC.defaultRecruitTime || "いまから"}\`\n\nVC内から募集メッセージを投稿できる機能です。`,
        feature: "recruitEnabled", toggle: "toggle_recruit", label: "募集機能",
        extraBtn: createBtn("config_recruit_id", "🆔 チャンネルID設定", ButtonStyle.Primary),
        extraBtn2: createBtn("config_recruit_role_id", "🆔 ロールID設定", ButtonStyle.Primary),
        extraBtn3: createBtn("config_recruit_defaults", "📝 初期値設定", ButtonStyle.Primary),
        selects: [
          { id: "select_cfg_recruit", ph: "📢 募集板チャンネルを選択", type: [ChannelType.GuildText] },
          { id: "select_cfg_recruit_role", ph: "🔔 募集ロールを選択 (複数可)", role: true, multi: true }
        ], back: "vc_features"
      }
    }[type];

    const isEnabled = features[configs.feature];
    const statusLabel = isEnabled ? "` 🟢 有効 `" : "` 🔴 無効 `";
    const cleanedDesc = configs.desc.replace(/`未設定`/g, "`未設定` 🟥");
    embed.setTitle(configs.title).setDescription(`${statusLabel}\n\n${cleanedDesc}`);
    const row1Btns = [createBtn(configs.toggle, `${configs.label}: ${isEnabled ? "有効" : "無効"}`, isEnabled ? ButtonStyle.Success : ButtonStyle.Danger)];
    if (configs.extraBtn) row1Btns.push(configs.extraBtn.setDisabled(!isEnabled));
    if (configs.extraBtn2) row1Btns.push(configs.extraBtn2.setDisabled(!isEnabled));
    if (configs.extraBtn3) row1Btns.push(configs.extraBtn3); // 常に有効化
    if (configs.extraBtn4) row1Btns.push(configs.extraBtn4); // 常に有効化
    components.push(createRow(row1Btns));

    // triggerの場合はスロット一覧ボタンを追加
    if (type === "trigger") {
      const slots = dynamicVC.vcSlots || [];
      if (slots.length > 0) {
        // スロットを最大4つずつの行に分けて表示
        const slotBtns = slots.map((s, idx) => {
          const chName = s.triggerChannelId ? (client.guilds.cache.get(gid)?.channels.cache.get(s.triggerChannelId)?.name || `CH:${s.triggerChannelId}`) : "未設定";
          const limitLabel = s.limit === 0 ? "∞" : `${s.limit}人`;
          return createBtn(`cfg_trigger_slot_${idx}`, `${s.name} (${limitLabel}) | #${chName}`, ButtonStyle.Secondary);
        });
        // 5つずつ行を分ける
        for (let r = 0; r < slotBtns.length; r += 5) {
          components.push(createRow(slotBtns.slice(r, r + 5)));
        }
      }
    } else {
      (configs.selects || [configs.select]).filter(Boolean).forEach(s => {
        let menu;
        if (s.role) menu = new RoleSelectMenuBuilder();
        else if (s.user) menu = new UserSelectMenuBuilder();
        else menu = new ChannelSelectMenuBuilder().setChannelTypes(s.type);
        if (s.multi) menu.setMaxValues(25);
        const canUse = isEnabled || s.user;
        components.push(createRow([menu.setCustomId(s.id).setPlaceholder(canUse ? s.ph : "⛔ 無効なため設定不可").setDisabled(!canUse)]));
      });
    }
    const backId = configs.back ? `cfg_btn_${configs.back}` : "cfg_back_main";
    components.push(createRow([createBtn(backId, "⬅️ 戻る")]));
  }
  return { embeds: [embed], components, ephemeral: true, flags: [MessageFlags.SuppressNotifications] };
}

// ─── VCスロット説明文生成 ─────────────────────────────────────────────────────
function buildTriggerDesc(dynamicVC, guild) {
  const slots = dynamicVC.vcSlots || [];
  let desc = "";
  if (slots.length === 0) {
    desc += "`スロットなし` — ➕ スロット追加ボタンで設定を作成してください。\n";
  } else {
    slots.forEach((s, idx) => {
      const chMention = s.triggerChannelId ? `<#${s.triggerChannelId}>` : "`未設定`";
      const limitLabel = s.limit === 0 ? "∞" : `${s.limit}人`;
      let typeLabel = "";
      if (s.isPrivate) typeLabel = " (非公開)";
      else if (s.isFixed) typeLabel = " (簡易)";
      desc += `**[${idx + 1}]** \`${s.name}\` (${limitLabel})${typeLabel} ─ ${chMention}\n`;
    });
  }
  desc += "\n特定のチャンネルに入室した際、自動で新しいVCを作成します。";
  return desc;
}

// ─── パネル更新 ──────────────────────────────────────────────────────────────
async function setupSettingsPanel(gid, config = null) {
  const g = config || await getGuildConfig(gid);
  const SETTINGS_CHANNEL_ID = g.dynamicVC?.settingsChannelId;
  if (!SETTINGS_CHANNEL_ID) return;
  const channel = client.channels.cache.get(SETTINGS_CHANNEL_ID); if (!channel) return;
  try {
    const msgs = await channel.messages.fetch({ limit: 50 });
    const toDelete = msgs.filter(m => m.author.id === client.user.id);
    if (toDelete.size > 0) {
      if (channel.type === ChannelType.GuildText) {
        await channel.bulkDelete(toDelete).catch(() => {
          // 2週間以上前のメッセージが含まれる場合は個別削除
          toDelete.forEach(async m => await m.delete().catch(() => { }));
        });
      } else {
        for (const m of toDelete.values()) await m.delete().catch(() => { });
      }
    }
  } catch (err) { console.error("パネル削除エラー:", err.message); }

  const meta = { version: (g.meta.version || 0) + 1, lastUpdated: new Date().toISOString() };
  await updateGuildConfig(gid, { $set: { meta } });

  const payload = await getSettingsPayload(gid, "main", g);
  payload.embeds[0].setFooter({ text: `Last Updated: ${new Date(meta.lastUpdated).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` });
  await channel.send({ ...payload, flags: [MessageFlags.SuppressNotifications] });
}

async function setupCreatePanel(gid) {
  const g = await getGuildConfig(gid);
  const channelId = g.dynamicVC.createPanelChannelId; if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId); if (!channel) return;
    const msgs = await channel.messages.fetch({ limit: 20 }); for (const m of msgs.filter(m => m.author.id === client.user.id).values()) await m.delete().catch(() => { });
    const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle("🎙️ ボイスチャンネル作成").setDescription("作成したいVCのタイプを選択してください。\n-# 人数固定の部屋は、作成後に上限を変更できません。");
    const row = createRow([createBtn("create_vc_panel", "➕ 新規作成", ButtonStyle.Success), createBtn("create_vc_4", "👥 4人部屋", ButtonStyle.Secondary), createBtn("create_vc_5", "👥 5人部屋", ButtonStyle.Secondary)]);
    await channel.send({ embeds: [embed], components: [row], flags: [MessageFlags.SuppressNotifications] });
  } catch (err) { console.error(err.message); }
}

// ─── VCコントロールパネル ──────────────────────────────────────────────────────
async function buildPanelPayload(vc) {
  const g = await getGuildConfig(vc.guildId);
  const locked = lockedVCs.has(vc.id), gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, ownerId = vcOwners.get(vc.id), isFixed = limitLockedVCs.has(vc.id);
  const isPrivate = privateVCs.has(vc.id);
  let desc = `**部屋主** : <@${ownerId}>`;
  if (locked) {
    desc += `\n- 状態: 🔒 ロック中\n- 上限: \`${limit === 0 ? "無制限" : limit + "人"}\`\n- 制限: \`${gender === "male" ? "♂️ 男性専用" : gender === "female" ? "♀️ 女性専用" : "なし"}\``;
  }
  const embed = new EmbedBuilder().setColor(locked ? 0xed4245 : 0x2b2d31).setDescription(desc);

  if (isFixed) {
    const row = createRow([createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !g.features.afkEnabled)]);
    if (g.features.recruitEnabled) row.addComponents(createBtn(`vc_recruit_start_${vc.id}`, "📢 募集", ButtonStyle.Success));
    if (isPrivate) row.addComponents(createBtn(`vc_invite_btn_${vc.id}`, "➕ メンバー招待", ButtonStyle.Primary));
    return { embeds: [embed], components: [row] };
  }
  const row1 = createRow([createBtn("vc_rename", "✏️ 名前変更"), createBtn("vc_toggle_lock", locked ? "🔓 解除" : "🔒 ロック", locked ? ButtonStyle.Danger : ButtonStyle.Secondary), createBtn("vc_settings_btn", "🛡️ 制限設定", ButtonStyle.Secondary, !g.features.genderRoleEnabled), createBtn("vc_afk_prompt", "🛏️ お布団へ運ぶ", ButtonStyle.Secondary, !g.features.afkEnabled)]);
  const components = locked ? [row1, createRow([createBtn(`vc_knock_${vc.id}`, "🚪 ノックして参加申請", ButtonStyle.Success)])] : [row1];

  if (g.features.recruitEnabled) {
    components.push(new ActionRowBuilder().addComponents(createBtn(`vc_recruit_start_${vc.id}`, "📢 募集", ButtonStyle.Success)));
  }

  return { embeds: [embed], components };
}

async function buildVCSettingsPayload(vc) {
  const g = await getGuildConfig(vc.guildId);
  const gender = genderMode.get(vc.id) ?? null, limit = vc.userLimit ?? 0, gStyle = (m) => gender === m ? ButtonStyle.Success : ButtonStyle.Secondary, lStyle = (n) => limit === n ? ButtonStyle.Success : ButtonStyle.Secondary;
  const embed = new EmbedBuilder().setColor(0x2b2d31).setTitle("🛡️ Room Restrictions").setDescription(`現在の設定\n- 上限: \`${limit === 0 ? "無制限" : limit + "人"}\`\n- 制限: \`${gender === "male" ? "♂️ 男性専用" : gender === "female" ? "♀️ 女性専用" : "なし"}\``);
  return { embeds: [embed], components: [createRow([createBtn("label_g", "【性別】", ButtonStyle.Secondary, true), createBtn("vc_gender_none", "なし", gStyle(null), !g.features.genderRoleEnabled), createBtn("vc_gender_male", "♂️ 男性", gStyle("male"), !g.features.genderRoleEnabled), createBtn("vc_gender_female", "♀️ 女性", gStyle("female"), !g.features.genderRoleEnabled)]), createRow([createBtn("label_l", "【人数】", ButtonStyle.Secondary, true), createBtn("vc_limit_0", "∞", lStyle(0)), createBtn("vc_limit_4", "4人", lStyle(4)), createBtn("vc_limit_5", "5人", lStyle(5)), createBtn("vc_limit_custom", "指定...", ButtonStyle.Primary)]), createRow([createBtn("vc_main_panel", "⬅️ 戻る")])] };
}

async function sendOrUpdateControlPanel(vc, ensureBottom = false) {
  const oldId = controlPanelMsgIds.get(vc.id), payload = await buildPanelPayload(vc);
  if (oldId) {
    try {
      const msg = await vc.messages.fetch(oldId);
      const lastMsgs = await vc.messages.fetch({ limit: 1 });
      const isLast = lastMsgs.first()?.id === oldId;
      if (isLast) {
        await msg.edit(payload);
        return;
      }
      if (ensureBottom) {
        await msg.delete().catch(() => { });
      } else {
        await msg.edit(payload);
        return;
      }
    } catch { }
  }
  try {
    const s = await vc.send({ ...payload, flags: [MessageFlags.SuppressNotifications] });
    controlPanelMsgIds.set(vc.id, s.id);
  } catch { }
}

async function updateVcName(vc, newName) {
  const now = Date.now(), last = renameTimestamps.get(vc.id) || 0;
  if (now - last < 300000) return vc.send({ content: "⚠️ 部屋名の変更は5分に1回までです。しばらく待ってからやり直してください。", flags: [MessageFlags.SuppressNotifications] }).then(m => setTimeout(() => m.delete().catch(() => { }), 5000));
  try { await vc.setName(newName); renameTimestamps.set(vc.id, now); await sendOrUpdateControlPanel(vc); } catch (e) { console.error(e); }
}

// ─── VC自動削除ヘルパー ──────────────────────────────────────────────────────
async function checkAndCleanupVC(vcId) {
  const vc = client.channels.cache.get(vcId);
  if (vc && vc.members.size === 0) {
    try {
      await vc.delete();
      [tempChannels, controlPanelMsgIds, lockedVCs, genderMode, vcOwners, pendingRequests, allowedUsers, knockNotifyMsgIds, renameTimestamps, introPosted, limitLockedVCs, privateVCs].forEach(s => s.delete(vcId));
    } catch (e) { }
  }
}

async function updateKnockNotifyMessage(vc) {
  const pending = pendingRequests.get(vc.id), applicantIds = pending ? [...pending.keys()] : [];
  if (applicantIds.length === 0) { const id = knockNotifyMsgIds.get(vc.id); if (id) try { await (await vc.messages.fetch(id)).delete(); } catch { } knockNotifyMsgIds.delete(vc.id); return; }
  const embeds = [new EmbedBuilder().setColor(0xf39c12).setTitle("🚪 ノックされています"), ...applicantIds.map(uid => new EmbedBuilder().setColor(0xf39c12).setDescription(`<@${uid}> が入室しようとしています。`).setThumbnail(vc.guild.members.cache.get(uid)?.user.displayAvatarURL() || null))];
  const rows = applicantIds.slice(0, 5).map(uid => createRow([createBtn(`knock_approve_${vc.id}_${uid}`, "✨ 歓迎する", ButtonStyle.Success), createBtn(`knock_deny_${vc.id}_${uid}`, "🤝 お断りする", ButtonStyle.Danger)]));
  const id = knockNotifyMsgIds.get(vc.id); try { if (id) await (await vc.messages.fetch(id)).edit({ embeds, components: rows }); else { const s = await vc.send({ embeds, components: rows, flags: [MessageFlags.SuppressNotifications] }); knockNotifyMsgIds.set(vc.id, s.id); } } catch { }
}

async function createDynamicVC(guild, member, name, limit, g) {
  try {
    const vc = await guild.channels.create({
      name,
      type: ChannelType.GuildVoice,
      parent: g.dynamicVC?.cleanupCategoryId,
      userLimit: limit,
      permissionOverwrites: [
        { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }
      ]
    });
    tempChannels.add(vc.id);
    vcOwners.set(vc.id, member.id);
    if (limit) limitLockedVCs.add(vc.id);
    await sendOrUpdateControlPanel(vc);
    const delMin = g.dynamicVC.autoDeleteMinutes || 5;
    setTimeout(() => checkAndCleanupVC(vc.id), delMin * 60 * 1000);
    return vc;
  } catch (e) {
    console.error("VC作成エラー:", e);
    return null;
  }
}

// ─── メッセージ受信時 (VC内テキスト等) ──────────────────────────────────────────
client.on(Events.MessageCreate, async (m) => {
  if (m.author.bot || !m.guild) return;
  if (m.channel.type === ChannelType.GuildVoice) {
    // 常に最後に表示させるための再配置
    if (tempChannels.has(m.channel.id)) {
      sendOrUpdateControlPanel(m.channel, true).catch(() => {});
    }
  }
});

// ─── インタラクション ─────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (i) => {
  if (i.isChatInputCommand()) {
    const gid = i.guildId;
    if (i.commandName === "setup") {
      if (!i.member.permissions.has(PermissionFlagsBits.Administrator)) return i.reply({ content: "管理者のみ実行可能です。", ephemeral: true });
      await updateGuildConfig(gid, { $set: { "dynamicVC.settingsChannelId": i.channelId } });
      const updatedG = await getGuildConfig(gid, true); // 最新設定を強制取得
      await i.reply({ content: "✅ このチャンネルを管理パネル設置先に設定しました。パネルを送信します...", ephemeral: true });
      return await setupSettingsPanel(gid, updatedG);
    }
    const cmd = client.commands.get(i.commandName);
    if (cmd) cmd.execute(i).catch(console.error);
    return;
  }

  const gid = i.guildId;
  const g = await getGuildConfig(gid);

  if (i.isButton()) {
    const cid = i.customId;
    if (cid.startsWith("vc_invite_btn_")) {
      const vcId = cid.replace("vc_invite_btn_", "");
      const vc = i.guild.channels.cache.get(vcId);
      if (!vc || vcOwners.get(vcId) !== i.user.id) {
        return i.reply({ content: "⚠️ あなたがこの部屋の部屋主である必要があります。", ephemeral: true });
      }
      return i.reply({
        content: "📥 招待したいメンバーを以下のメニューから選択してください（複数選択可）：",
        components: [createRow([new UserSelectMenuBuilder().setCustomId(`vc_invite_select_${vc.id}`).setPlaceholder("招待するメンバーを選択").setMaxValues(10)])],
        ephemeral: true
      });
    }
    if (cid.startsWith("create_vc_")) {
      if (!g.features.vcPanelEnabled) return i.reply({ content: "無効です", ephemeral: true });
      const limit = cid === "create_vc_4" ? 4 : cid === "create_vc_5" ? 5 : 0;

      if (limit > 0) {
        // 4人部屋・5人部屋は名前固定で即時作成
        const name = limit === 4 ? (g.dynamicVC.channelName4 || "雑談4人部屋") : (g.dynamicVC.channelName5 || "雑談5人部屋");
        await i.deferReply({ ephemeral: true });
        const vc = await createDynamicVC(i.guild, i.member, name, limit, g);
        if (vc) return i.editReply({ content: `✅ **${vc.name}** を作成しました。` });
        return i.editReply({ content: "❌ VCの作成に失敗しました。" });
      }

      // 自由枠はモーダルを表示
      let defaultName = g.dynamicVC.channelName ? g.dynamicVC.channelName.replace("{user}", i.member.displayName) : `${i.member.displayName}のVC`;
      return i.showModal(new ModalBuilder().setCustomId(`create_vc_modal_${limit}`).setTitle("VC作成").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("名前").setStyle(TextInputStyle.Short).setValue(defaultName).setRequired(true)])));
    }
    if (cid === "vc_toggle_lock") {
      const vc = i.member.voice.channel; if (!vc || !tempChannels.has(vc.id) || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      lockedVCs.has(vc.id) ? lockedVCs.delete(vc.id) : lockedVCs.add(vc.id);
      await i.deferUpdate();
      return sendOrUpdateControlPanel(vc, true);
    }
    if (cid === "vc_settings_btn") {
      const vc = i.member.voice.channel;
      if (vc && tempChannels.has(vc.id) && vcOwners.get(vc.id) === i.user.id && g.features.genderRoleEnabled) {
        return i.update(await buildVCSettingsPayload(vc));
      }
      return i.deferUpdate();
    }
    if (cid === "vc_main_panel") {
      const vc = i.member.voice.channel;
      if (vc && tempChannels.has(vc.id)) {
        await i.deferUpdate();
        return sendOrUpdateControlPanel(vc, true);
      }
      return i.deferUpdate();
    }
    if (cid.startsWith("vc_gender_")) {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      const mode = cid.split("_")[2]; if (mode === "none") genderMode.delete(vc.id); else genderMode.set(vc.id, mode);
      await i.update(await buildVCSettingsPayload(vc));
      const overwrites = [{ id: vc.guild.roles.everyone.id, [mode ? 'deny' : 'allow']: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }];
      if (mode) overwrites.push({ id: g.roles[mode], allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }, { id: g.roles[mode === 'male' ? 'female' : 'male'], deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
      return vc.permissionOverwrites.set(overwrites).catch(console.error);
    }
    if (cid.startsWith("vc_limit_") && cid !== "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: g.messages.limitLockedWarning, ephemeral: true });
      await vc.setUserLimit(parseInt(cid.split("_")[2]));
      await i.deferUpdate();
      return sendOrUpdateControlPanel(vc, true);
    }
    if (cid === "vc_limit_custom") {
      const vc = i.member.voice.channel; if (!vc || vcOwners.get(vc.id) !== i.user.id) return i.deferUpdate();
      if (limitLockedVCs.has(vc.id)) return i.reply({ content: g.messages.limitLockedWarning, ephemeral: true });
      return i.showModal(new ModalBuilder().setCustomId(`limit_modal_${vc.id}`).setTitle("上限設定").addComponents(createRow([new TextInputBuilder().setCustomId("limit").setLabel("人数(0-99)").setStyle(TextInputStyle.Short).setRequired(true)])));
    }
    if (cid === "vc_rename") { const vc = i.member.voice.channel; if (vc && vcOwners.get(vc.id) === i.user.id) return i.showModal(new ModalBuilder().setCustomId(`rename_modal_${vc.id}`).setTitle("名前変更").addComponents(createRow([new TextInputBuilder().setCustomId("name").setLabel("新しい名前").setStyle(TextInputStyle.Short).setRequired(true)]))); return i.deferUpdate(); }
    if (cid === "vc_afk_prompt") {
      if (!g.features.afkEnabled) return i.reply({ content: "無効", ephemeral: true });
      const vc = i.member.voice.channel; if (!vc || vc.id !== i.channelId) return i.reply({ content: "このVCに参加中のみ可", ephemeral: true });
      return i.reply({ content: "移動させる人を選択", components: [createRow([new UserSelectMenuBuilder().setCustomId(`vc_afk_select_${vc.id}`).setPlaceholder("選択").setMaxValues(1)])], ephemeral: true });
    }
    // 報告ボタン
    if (cid.startsWith("relay_rpt_")) {
      const reportedUserId = cid.replace("relay_rpt_", "");
      const member = await i.guild.members.fetch(reportedUserId).catch(() => null);
      const displayName = member?.displayName || reportedUserId;
      return i.showModal(
        new ModalBuilder().setCustomId(`relay_rpt_modal_${reportedUserId}`).setTitle("問題報告")
          .addComponents(
            createRow([new TextInputBuilder()
              .setCustomId("reason")
              .setLabel(`「${displayName}」に問題がある理由を入力してください`)
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder("例: 記載内容に単純な広告が含まれている")
              .setRequired(true)
            ])
          )
      );
    }
    if (cid === "cfg_member_count_details") {
      await i.deferReply({ ephemeral: true });
      const roles = g.roles || {};
      let isCache = false;
      try {
        const roleIds = [roles.male, roles.female].filter(Boolean);
        if (roleIds.length > 0) {
          // フェッチを試みるが、失敗しても無視してキャッシュを使う
          await i.guild.members.fetch({ role: roleIds }).catch(() => { isCache = true; });
        }
      } catch (e) { isCache = true; }
      
      const humans = i.guild.members.cache.filter(m => !m.user.bot);
      const males = roles.male ? humans.filter(m => m.roles.cache.has(roles.male)) : new Map();
      const females = roles.female ? humans.filter(m => m.roles.cache.has(roles.female)) : new Map();
      const others = humans.filter(m => (roles.male ? !m.roles.cache.has(roles.male) : true) && (roles.female ? !m.roles.cache.has(roles.female) : true));

      const listNames = (col, max = 20) => {
        if (!col || col.size === 0) return "なし";
        const names = col.map(m => m.displayName);
        if (names.length <= max) return names.join(", ");
        return names.slice(0, max).join(", ") + ` ほか ${names.length - max}名`;
      };

      const embed = new EmbedBuilder()
        .setTitle("👥 メンバー内訳詳細")
        .setDescription(isCache ? "-# ⚠️ Discord制限中のため、現在のキャッシュ情報を表示しています。" : "-# 最新の情報に基づいた一覧です。")
        .setColor(isCache ? 0xe67e22 : 0x5865f2)
        .addFields(
          { name: `♂ 男性 (${males.size || 0}人)`, value: listNames(males) },
          { name: `♀ 女性 (${females.size || 0}人)`, value: listNames(females) },
          { name: `👤 その他 (${others.size || 0}人)`, value: listNames(others) }
        )
        .setFooter({ text: `ロール合計 (♂+♀): ${males.size + females.size}人 / サーバー全体: ${i.guild.memberCount}人` })
        .setTimestamp();
      return i.editReply({ embeds: [embed] });
    }
    if (cid === "cfg_back_main") return i.update(await getSettingsPayload(gid, "main", g));
    if (cid === "cfg_btn_raw") {
      const json = JSON.stringify(g, null, 2);
      return i.reply({ content: `### 📂 データベース内の生データ\n\`\`\`json\n${json.length > 1900 ? json.substring(0, 1900) + "...(省略)" : json}\n\`\`\``, ephemeral: true });
    }
    if (cid === "cfg_btn_restart") {
      await i.reply({ content: "🔄 ボットを再起動します... (数秒後に復帰します)", ephemeral: true });
      console.log("🚀 User requested restart. Exiting...");
      process.exit(0);
    }
    if (cid.startsWith("vc_join_click_")) {
      const vid = cid.replace("vc_join_click_", "");
      return i.reply({ content: `https://discord.com/channels/${gid}/${vid}`, ephemeral: true });
    }
    if (cid === "cfg_btn_refresh") {
      await i.reply({ content: "♻️ パネルを再送信しています...", ephemeral: true });
      await setupSettingsPanel(gid, g);
      await setupCreatePanel(gid);
      return;
    }

    if (cid.startsWith("vc_recruit_start_")) {
      const targetVcId = cid.replace("vc_recruit_start_", "");
      const vc = i.member.voice.channel;
      if (!vc || vc.id !== targetVcId) return i.reply({ content: "このVCに参加中のみ実行可能です。", ephemeral: true });
      if (!g.dynamicVC.recruitmentChannelId) return i.reply({ content: "募集板チャンネルが設定されていません。", ephemeral: true });

      const rolesIds = g.dynamicVC.recruitmentRoleIds || [];
      if (g.dynamicVC.recruitmentRoleId && !rolesIds.includes(g.dynamicVC.recruitmentRoleId)) rolesIds.push(g.dynamicVC.recruitmentRoleId);

      const opts = [];
      for (const rId of rolesIds) {
        const r = i.guild.roles.cache.get(rId);
        if (r) opts.push({ label: `@${r.name}`, value: rId, description: "設定済みの募集ロールへ通知します" });
      }
      opts.push({ label: "メンションなし", value: "none", description: "メンションを付けずに募集します" });

      const menu1 = new StringSelectMenuBuilder().setCustomId(`rmnu_str_${vc.id}`).setPlaceholder("メンション先を選択").addOptions(opts);
      return i.reply({ content: "📢 募集メッセージのメンション先を選択してください。", components: [createRow([menu1])], ephemeral: true });
    }
    if (cid === "cfg_intro_restore") {
      await i.reply({ content: "⏳ チャンネル内のメッセージをスキャンして復元を開始します...", ephemeral: true });
      let statusCount = 0, contentCount = 0;
      const scan = async (cid, isSource) => {
        const ch = i.guild.channels.cache.get(cid); if (!ch || !ch.isTextBased()) return;
        let lastId = null;
        while (true) {
          const msgs = await ch.messages.fetch({ limit: 100, before: lastId }); if (msgs.size === 0) break;
          for (const m of msgs.values()) {
            if (m.author.bot) continue;
            const data = isSource ? { content: (m.content + (m.attachments.size ? "\n" + m.attachments.map(a => a.url).join("\n") : "")).trim() } : { introduced: true };
            await Intro.findOneAndUpdate({ guildId: gid, userId: m.author.id }, { $set: data }, { upsert: true });
            if (isSource) contentCount++; else statusCount++;
          }
          lastId = msgs.lastKey();
        }
      };
      if (g.dynamicVC.introCheckChannelId) await scan(g.dynamicVC.introCheckChannelId, false);
      const sources = g.dynamicVC.introSourceChannelIds || (g.dynamicVC.introSourceChannelId ? [g.dynamicVC.introSourceChannelId] : []);
      for (const sid of sources) await scan(sid, true);
      return i.followUp({ content: `✅ 復元が完了しました！\n- 提出ステータス: ${statusCount} 件\n- 自己紹介本文: ${contentCount} 件\nをデータベースに保存しました。`, ephemeral: true });
    }
    if (cid === "cfg_intro_list") {
      const list = await Intro.find({ guildId: gid, introduced: true }).sort({ _id: -1 }).limit(100);
      if (list.length === 0) return i.reply({ content: "承認済みのユーザーはいません。", ephemeral: true });
      const desc = list.map(u => `- <@${u.userId}> (\`${u.userId}\`)`).join("\n");
      return i.reply({ content: `### 📋 承認済みユーザー (最新100件)\n${desc.length > 1900 ? desc.substring(0, 1900) + "\n...その他" : desc}`, ephemeral: true });
    }
    if (cid === "cfg_intro_sync_all") {
      await i.deferReply({ ephemeral: true });
      const members = await i.guild.members.fetch();
      const ops = [];
      for (const m of members.values()) {
        if (m.user.bot) continue;
        ops.push({
          updateOne: {
            filter: { guildId: gid, userId: m.id },
            update: { $set: { introduced: true } },
            upsert: true
          }
        });
      }
      if (ops.length > 0) await Intro.bulkWrite(ops);
      return i.editReply({ content: `✅ 現在サーバーにいる全ユーザー (${ops.length}名) を承認済みリストに追加しました。` });
    }
    if (cid === "cfg_btn_auto_delete") return i.showModal(new ModalBuilder().setCustomId("auto_delete_modal").setTitle("削除タイマー設定").addComponents(createRow([new TextInputBuilder().setCustomId("minutes").setLabel("空室削除までの時間 (分)").setStyle(TextInputStyle.Short).setValue(String(g.dynamicVC.autoDeleteMinutes || 5)).setRequired(true)])));

    if (cid.startsWith("cfg_btn_")) return i.update(await getSettingsPayload(gid, cid.replace("cfg_btn_", ""), g));

    if (cid === "config_roles_id") {
      return i.showModal(new ModalBuilder().setCustomId("roles_id_modal").setTitle("ロールID設定").addComponents(
        createRow([new TextInputBuilder().setCustomId("male").setLabel("♂️ 男性ロールID").setStyle(TextInputStyle.Short).setValue(g.roles.male || "").setPlaceholder("ロールIDを入力").setRequired(false)]),
        createRow([new TextInputBuilder().setCustomId("female").setLabel("♀️ 女性ロールID").setStyle(TextInputStyle.Short).setValue(g.roles.female || "").setPlaceholder("ロールIDを入力").setRequired(false)])
      ));
    }
    if (cid === "config_recruit_id") {
      return i.showModal(new ModalBuilder().setCustomId("recruit_id_modal").setTitle("募集板ID設定").addComponents(
        createRow([new TextInputBuilder().setCustomId("cid").setLabel("募集板チャンネルID").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.recruitmentChannelId || "").setPlaceholder("チャンネルIDを入力").setRequired(true)])
      ));
    }
    if (cid === "config_recruit_role_id") {
      const currentVal = (g.dynamicVC.recruitmentRoleIds?.length > 0) ? g.dynamicVC.recruitmentRoleIds.join(", ") : (g.dynamicVC.recruitmentRoleId || "");
      return i.showModal(new ModalBuilder().setCustomId("recruit_role_id_modal").setTitle("募集ロールID設定").addComponents(
        createRow([new TextInputBuilder().setCustomId("rid").setLabel("募集ロールID (複数可, カンマ区切り)").setStyle(TextInputStyle.Short).setValue(currentVal).setPlaceholder("例: 1234567, 8901234").setRequired(false)])
      ));
    }
    if (cid === "config_recruit_defaults") {
      return i.showModal(new ModalBuilder().setCustomId("recruit_defaults_modal").setTitle("募集時の初期値設定").addComponents(
        createRow([new TextInputBuilder().setCustomId("def_content").setLabel("募集内容の初期値").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.defaultRecruitContent || "雑談").setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("def_time").setLabel("日時の初期値").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.defaultRecruitTime || "いまから").setRequired(true)])
      ));
    }
    if (cid === "cfg_member_count_update") {
      await i.deferReply({ ephemeral: true });
      await updateMemberCountChannels(i.guild);
      return i.editReply({ content: "✅ カウンターを更新しました！" });
    }
    if (cid === "cfg_member_count_format") {
      const currentFmt = g.dynamicVC.memberCountFormat || "♂ {male}人・♀ {female}人・👤 {total}人";
      return i.showModal(
        new ModalBuilder().setCustomId("member_count_format_modal").setTitle("表示形式編集")
          .addComponents(createRow([new TextInputBuilder()
            .setCustomId("fmt")
            .setLabel("チャンネル名の形式 (\u30d7レースホルダー使用可)")
            .setStyle(TextInputStyle.Short)
            .setValue(currentFmt)
            .setPlaceholder("♂ {male}人・♀ {female}人・👤 {total}人")
            .setRequired(true)
          ]))
      );
    }
    if (cid === "cfg_msg_relay_cutoff") {
      return i.showModal(
        new ModalBuilder().setCustomId("msg_relay_cutoff_modal").setTitle("省略文字列設定")
          .addComponents(createRow([new TextInputBuilder()
            .setCustomId("cutoff")
            .setLabel("この文字列以降を省略 (空白で解除)")
            .setStyle(TextInputStyle.Short)
            .setValue(g.dynamicVC.msgRelayCutoff || "")
            .setPlaceholder("例: ～～面談日時～～")
            .setRequired(false)
          ]))
      );
    }
    const toggles = { toggle_afk: "afkEnabled", toggle_panel: "vcPanelEnabled", toggle_vc_creation: "vcCreationEnabled", toggle_intro_kick: "introKickEnabled", toggle_vc_intro: "vcIntroDisplayEnabled", toggle_gender: "genderRoleEnabled", toggle_recruit: "recruitEnabled", toggle_member_count: "memberCountEnabled", toggle_msg_relay: "msgRelayEnabled" };
    if (toggles[cid]) {
      const key = toggles[cid];
      const newFeatures = { ...g.features, [key]: !g.features[key] };
      const map = {
        afkEnabled: "afk",
        vcPanelEnabled: "panel",
        vcCreationEnabled: "trigger",
        introKickEnabled: "intro_kick",
        vcIntroDisplayEnabled: "intro_display",
        genderRoleEnabled: "vc",
        memberCountEnabled: "member_count",
        msgRelayEnabled: "msg_relay"
      };
      const nextType = map[key];
      await updateGuildConfig(gid, { $set: { features: newFeatures } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, nextType, updatedG));
      if (key === "memberCountEnabled") {
        if (!g.features.memberCountEnabled) {
          // 有効化: 即時カウンター更新（ロック＋移動含む）
          await updateMemberCountChannels(i.guild);
        } else {
          // 無効化: チャンネル名を元に戻す＋ロック解除
          await clearMemberCountChannels(i.guild);
        }
      }
    }

    if (cid === "config_intro_time") return i.showModal(new ModalBuilder().setCustomId("intro_time_modal").setTitle("期限設定").addComponents(createRow([new TextInputBuilder().setCustomId("warn").setLabel("警告(分)").setStyle(TextInputStyle.Short).setValue(String(g.dynamicVC.introWarnMinutes || 2880))]), createRow([new TextInputBuilder().setCustomId("kick").setLabel("キック(分)").setStyle(TextInputStyle.Short).setValue(String(g.dynamicVC.introKickMinutes || 4320))])));
    // スロット追加ボタン
    if (cid === "cfg_trigger_add_slot") {
      return i.showModal(new ModalBuilder().setCustomId("trigger_slot_add_modal").setTitle("VCスロット追加").addComponents(
        createRow([new TextInputBuilder().setCustomId("slot_name").setLabel("部屋名 ({user}使用可)").setStyle(TextInputStyle.Short).setValue("{user}のVC").setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("slot_limit").setLabel("人数上限 (0=無制限)").setStyle(TextInputStyle.Short).setValue("0").setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("slot_trigger").setLabel("トリガーチャンネルID").setStyle(TextInputStyle.Short).setPlaceholder("VCチャンネルのIDを入力").setRequired(false)]),
        createRow([new TextInputBuilder().setCustomId("slot_type").setLabel("タイプ (0=標準, 1=簡易, 2=非公開)").setStyle(TextInputStyle.Short).setValue("0").setRequired(true)])
      ));
    }
    // スロット編集ボタン (cfg_trigger_slot_{idx})
    if (cid.startsWith("cfg_trigger_slot_")) {
      const idx = parseInt(cid.replace("cfg_trigger_slot_", ""));
      const slots = g.dynamicVC.vcSlots || [];
      const slot = slots[idx];
      if (!slot) return i.reply({ content: "❌ スロットが見つかりません。", ephemeral: true });
      let currentType = "0";
      if (slot.isPrivate) currentType = "2";
      else if (slot.isFixed) currentType = "1";
      return i.showModal(new ModalBuilder().setCustomId(`trigger_slot_edit_modal_${idx}`).setTitle(`スロット[${idx + 1}]編集`).addComponents(
        createRow([new TextInputBuilder().setCustomId("slot_name").setLabel("部屋名 ({user}使用可)").setStyle(TextInputStyle.Short).setValue(slot.name || "{user}のVC").setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("slot_limit").setLabel("人数上限 (0=無制限)").setStyle(TextInputStyle.Short).setValue(String(slot.limit ?? 0)).setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("slot_trigger").setLabel("トリガーチャンネルID").setStyle(TextInputStyle.Short).setValue(slot.triggerChannelId || "").setPlaceholder("VCチャンネルのIDを入力 (空白で削除)").setRequired(false)]),
        createRow([new TextInputBuilder().setCustomId("slot_type").setLabel("タイプ (0=標準, 1=簡易, 2=非公開)").setStyle(TextInputStyle.Short).setValue(currentType).setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("slot_delete").setLabel("削除する場合は \"delete\" と入力").setStyle(TextInputStyle.Short).setPlaceholder("削除しない場合は空白のままで").setRequired(false)])
      ));
    }
    if (cid === "config_messages") return i.reply({ content: "編集カテゴリ選択", components: [createRow([createBtn("msg_modal_intro", "自己紹介関連", ButtonStyle.Primary), createBtn("msg_modal_vc", "VC関連", ButtonStyle.Primary)])], ephemeral: true });
    if (cid.startsWith("msg_modal_")) {
      const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"], labels = isIntro ? ["確認通知", "期限警告", "未記入キックDM"] : ["上限固定エラー", "男性専用エラーDM", "女性専用エラーDM"];
      return i.showModal(new ModalBuilder().setCustomId(`msg_submit_${isIntro ? 'intro' : 'vc'}`).setTitle("メッセージ編集").addComponents(keys.map((k, j) => createRow([new TextInputBuilder().setCustomId(k).setLabel(labels[j]).setStyle(TextInputStyle.Paragraph).setValue((g.messages[k] || "").replace(/\\n/g, '\n'))]))));
    }
    if (cid.startsWith("vc_knock_")) {
      const vcId = cid.replace("vc_knock_", ""), vc = i.guild.channels.cache.get(vcId); if (!vc || i.member.voice.channelId === vcId || vcOwners.get(vcId) === i.user.id || !lockedVCs.has(vcId)) return i.deferUpdate();
      if (!pendingRequests.has(vcId)) pendingRequests.set(vcId, new Map()); pendingRequests.get(vcId).set(i.user.id, true); await updateKnockNotifyMessage(vc); return i.deferUpdate();
    }
    if (cid.startsWith("knock_approve_") || cid.startsWith("knock_deny_")) {
      const [, , vcId, uid] = cid.split("_"), vc = i.guild.channels.cache.get(vcId); if (!vc || vcOwners.get(vcId) !== i.user.id) return i.deferUpdate();
      await i.deferUpdate();
      pendingRequests.get(vcId)?.delete(uid);
      if (cid.includes("approve")) { if (!allowedUsers.has(vcId)) allowedUsers.set(vcId, new Set()); allowedUsers.get(vcId).add(uid); const m = await i.guild.members.fetch(uid).catch(() => null); if (m?.voice.channel) m.voice.setChannel(vc).catch(() => vc.send(`✨ <@${uid}> さん、どうぞお入りください！`)); else vc.send(`✨ <@${uid}> さん、どうぞお入りください！`).then(msg => setTimeout(() => msg.delete().catch(() => { }), 60000)); }
      return updateKnockNotifyMessage(vc);
    }
    if (cid.startsWith("role_assign_")) {
      const [, , uid, mode] = cid.split("_"), member = await i.guild.members.fetch(uid).catch(() => null);
      if (!member) return i.update({ content: "❌ ユーザーが見つかりませんでした。", components: [] });
      if (mode === "none") return i.update({ content: "✅ お断りしました。", components: [] });
      try { const roleId = g.roles[mode]; if (roleId) await member.roles.add(roleId); await i.update({ content: `✅ <@${uid}> を ${mode === 'male' ? '男性' : '女性'}グループに追加しました！`, components: [] }); } catch (e) { await i.update({ content: `❌ エラー: ${e.message}`, components: [] }); }
    }
  }

  if (i.isModalSubmit()) {
    const cid = i.customId;
    if (cid.startsWith("create_vc_modal_")) {
      const name = i.fields.getTextInputValue("name"), limit = parseInt(cid.split("_")[3]);
      await silentReply(i);
      await createDynamicVC(i.guild, i.member, name, limit, g);
    }
    if (cid.startsWith("rmodal_")) {
      const parts = cid.replace("rmodal_", "").split("_");
      const token = parts[0];
      const vcId = parts[1];
      const content = i.fields.getTextInputValue("content"), time = i.fields.getTextInputValue("time"), comment = i.fields.getTextInputValue("comment");
      const vc = i.guild.channels.cache.get(vcId); if (!vc) return silentReply(i);
      const ch = i.guild.channels.cache.get(g.dynamicVC.recruitmentChannelId); if (!ch) return silentReply(i);

      let selections = recruitSelections.get(token) || ["none"];
      if (selections.length > 1 && selections.includes("none")) selections = selections.filter(s => s !== "none");

      let mentionStr = "";
      if (!selections.includes("none")) {
        mentionStr = selections.map(val => {
          if (val === "role" && g.dynamicVC.recruitmentRoleId) return `<@&${g.dynamicVC.recruitmentRoleId}>`;
          if (val === "everyone") return "@everyone";
          if (val === "here") return "@here";
          return `<@&${val}>`;
        }).join(" ");
      }

      const limit = vc.userLimit ?? 0;
      const gender = genderMode.get(vc.id);

      let desc = `募集内容: ${content}\n`;
      desc += `日時: ${time}\n`;
      const vcUrl = `https://discord.com/channels/${i.guildId}/${vcId}`;
      desc += `場所: ${vcUrl}\n`;
      if (mentionStr) desc += `メンション: ${mentionStr}\n`;
      if (lockedVCs.has(vc.id)) desc += `状態: 🔒 ロック中 (参加前にノックが必要です)\n`;
      if (limit > 0) desc += `上限: ${limit}人\n`;
      if (gender === "male") desc += `制限: ♂️ 男性専用\n`;
      else if (gender === "female") desc += `制限: ♀️ 女性専用\n`;
      if (comment) desc += `一言: ${comment.replace(/\n/g, " ")}`;
      desc = desc.trim();

      const link = `https://discord.com/channels/${i.guildId}/${vcId}`;

      // 古い募集メッセージ（Embed付きのもの）を一旦お掃除する
      try {
        const msgs = await ch.messages.fetch({ limit: 20 });
        const oldEmbeds = msgs.filter(m => m.author.id === i.client.user.id && m.embeds.length > 0);
        for (const [id, m] of oldEmbeds) await m.delete().catch(() => { });
      } catch (e) { }



      // 2. Webhookを利用して募集主本人のアイコンと名前でプレーンテキストとして送信
      let webhook = null;
      try {
        const webhooks = await ch.fetchWebhooks();
        webhook = webhooks.find(wh => wh.owner && wh.owner.id === i.client.user.id);
        if (!webhook) webhook = await ch.createWebhook({ name: "VC Recruitment", avatar: i.client.user.displayAvatarURL() });
      } catch (e) { console.error(e); }

      if (webhook) {
        // 同じ募集主でも連続してアイコンが表示されるように、名前の2文字目に不可視文字をランダムに挿入（トリム対策＆グループ化防止）
        const nameChars = Array.from(i.member.displayName);
        const randomInvisibles = Array.from({ length: 4 }, () => ["\u200B", "\u200C", "\u200D"][Math.floor(Math.random() * 3)]).join('');
        if (nameChars.length > 0) nameChars.splice(1, 0, randomInvisibles);
        const webhookName = nameChars.join('');

        await webhook.send({
          content: desc,
          username: webhookName,
          avatarURL: i.member.displayAvatarURL({ dynamic: true })
        });
      } else {
        await ch.send({ content: desc });
      }
      return i.update({ content: "✅ 募集を投稿しました！", components: [] });
    }
    if (cid.startsWith("limit_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("limit_modal_", "")), val = parseInt(i.fields.getTextInputValue("limit")); await silentReply(i); if (vc && !isNaN(val)) { await vc.setUserLimit(val); await sendOrUpdateControlPanel(vc); } }
    if (cid.startsWith("rename_modal_")) { const vc = i.guild.channels.cache.get(cid.replace("rename_modal_", "")); await silentReply(i); if (vc) await updateVcName(vc, i.fields.getTextInputValue("name").trim()); }
    if (cid === "intro_time_modal") {
      const w = parseInt(i.fields.getTextInputValue("warn")), k = parseInt(i.fields.getTextInputValue("kick"));
      if (!isNaN(w) && !isNaN(k)) {
        await updateGuildConfig(gid, { $set: { "dynamicVC.introWarnMinutes": w, "dynamicVC.introKickMinutes": k } });
        const updatedG = await getGuildConfig(gid, true);
        await i.update(await getSettingsPayload(gid, "intro_kick", updatedG));

      }
    }
    // スロット追加モーダル
    if (cid === "trigger_slot_add_modal") {
      const slotName = i.fields.getTextInputValue("slot_name").trim();
      const slotLimit = parseInt(i.fields.getTextInputValue("slot_limit")) || 0;
      const slotTrigger = i.fields.getTextInputValue("slot_trigger").trim() || null;
      const typeVal = parseInt(i.fields.getTextInputValue("slot_type")) || 0;
      const isFixed = (typeVal === 1 || typeVal === 2);
      const isPrivate = (typeVal === 2);
      const slots = [...(g.dynamicVC.vcSlots || [])];
      slots.push({ name: slotName, limit: slotLimit, triggerChannelId: slotTrigger, isFixed, isPrivate });
      await updateGuildConfig(gid, { $set: { "dynamicVC.vcSlots": slots } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "trigger", updatedG));
    }
    // スロット編集・削除モーダル
    if (cid.startsWith("trigger_slot_edit_modal_")) {
      const idx = parseInt(cid.replace("trigger_slot_edit_modal_", ""));
      const slots = [...(g.dynamicVC.vcSlots || [])];
      if (idx < 0 || idx >= slots.length) return i.reply({ content: "❌ スロットが見つかりません。", ephemeral: true });
      const deleteFlag = i.fields.getTextInputValue("slot_delete").trim().toLowerCase();
      if (deleteFlag === "delete") {
        slots.splice(idx, 1);
        await updateGuildConfig(gid, { $set: { "dynamicVC.vcSlots": slots } });
        const updatedG = await getGuildConfig(gid, true);
        return i.update(await getSettingsPayload(gid, "trigger", updatedG));
      }
      const slotName = i.fields.getTextInputValue("slot_name").trim();
      const slotLimit = parseInt(i.fields.getTextInputValue("slot_limit")) || 0;
      const slotTrigger = i.fields.getTextInputValue("slot_trigger").trim() || null;
      const typeVal = parseInt(i.fields.getTextInputValue("slot_type")) || 0;
      const isFixed = (typeVal === 1 || typeVal === 2);
      const isPrivate = (typeVal === 2);
      slots[idx] = { name: slotName, limit: slotLimit, triggerChannelId: slotTrigger, isFixed, isPrivate };
      await updateGuildConfig(gid, { $set: { "dynamicVC.vcSlots": slots } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "trigger", updatedG));
    }
    if (cid.startsWith("relay_rpt_modal_")) {
      const reportedUserId = cid.replace("relay_rpt_modal_", "");
      const reason = i.fields.getTextInputValue("reason");
      const reporter = i.member;
      const reportedMember = await i.guild.members.fetch(reportedUserId).catch(() => null);

      // 元の転送メッセージを参照
      const relayedContent = i.message?.content || "";
      const msgLink = `https://discord.com/channels/${gid}/${i.channelId}/${i.message?.id}`;

      const g2 = await getGuildConfig(gid);
      const reportEmbed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("⚠️ 投稿内容に問題が報告されました")
        .addFields(
          { name: "👤 報告対象", value: reportedMember ? `<@${reportedUserId}> (${reportedMember.displayName})` : `<@${reportedUserId}>`, inline: true },
          { name: "🚨 報告者", value: `<@${reporter.id}> (${reporter.displayName})`, inline: true },
          { name: "📝 報告内容", value: reason },
          { name: "🔗 元の投稿先", value: `[${i.channel?.name || "チャンネル"}](${msgLink})` }
        )
        .setTimestamp();

      await i.reply({ content: "✅ 報告を送信しました。ご協力ありがとうございます。", ephemeral: true });

      const reportUserId = g2.dynamicVC?.msgRelayReportUserId;
      let targetUser = null;
      if (reportUserId) {
        targetUser = await client.users.fetch(reportUserId).catch(() => null);
      }
      if (!targetUser) {
        // 未設定の場合はサーバーオーナーにDM
        const owner = await i.guild.fetchOwner().catch(() => null);
        targetUser = owner?.user || null;
      }
      if (targetUser) await targetUser.send({ embeds: [reportEmbed] }).catch(console.error);
      return;
    }
    if (cid === "msg_relay_cutoff_modal") {
      const cutoff = i.fields.getTextInputValue("cutoff").trim();
      await updateGuildConfig(gid, { $set: { "dynamicVC.msgRelayCutoff": cutoff || null } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "msg_relay", updatedG));
      return;
    }
    if (cid === "member_count_format_modal") {
      const fmt = i.fields.getTextInputValue("fmt").trim();
      await updateGuildConfig(gid, { $set: { "dynamicVC.memberCountFormat": fmt } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "member_count", updatedG));
      await updateMemberCountChannels(i.guild);
      return;
    }
    if (cid.startsWith("msg_submit_")) {
      const isIntro = cid.includes("intro"), keys = isIntro ? ["introNotify", "introWarnMsg", "introKickDM"] : ["limitLockedWarning", "genderMaleOnlyDM", "genderFemaleOnlyDM"];
      const newMsgs = { ...g.messages }; keys.forEach(k => { newMsgs[k] = i.fields.getTextInputValue(k).replace(/\n/g, '\\n'); });
      await updateGuildConfig(gid, { $set: { messages: newMsgs } });
      return i.reply({ content: "✅ 更新完了", ephemeral: true });
    }
    if (cid === "auto_delete_modal") {
      const m = parseInt(i.fields.getTextInputValue("minutes"));
      if (!isNaN(m)) {
        await updateGuildConfig(gid, { $set: { "dynamicVC.autoDeleteMinutes": m } });
        const updatedG = await getGuildConfig(gid, true);
        await i.update(await getSettingsPayload(gid, "ch_features", updatedG));

      }
    }
    if (cid === "roles_id_modal") {
      const male = i.fields.getTextInputValue("male").trim(), female = i.fields.getTextInputValue("female").trim();
      await updateGuildConfig(gid, { $set: { "roles.male": male || null, "roles.female": female || null } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "vc", updatedG));

    }
    if (cid === "recruit_id_modal") {
      const val = i.fields.getTextInputValue("cid").trim();
      await updateGuildConfig(gid, { $set: { "dynamicVC.recruitmentChannelId": val || null } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "recruit", updatedG));

    }
    if (cid === "recruit_role_id_modal") {
      const val = i.fields.getTextInputValue("rid").trim();
      const ids = val ? val.split(/[,\s]+/).filter(id => id.match(/^\d+$/)) : [];
      await updateGuildConfig(gid, { $set: { "dynamicVC.recruitmentRoleIds": ids, "dynamicVC.recruitmentRoleId": null } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "recruit", updatedG));
    }
    if (cid === "recruit_defaults_modal") {
      const defC = i.fields.getTextInputValue("def_content").trim();
      const defT = i.fields.getTextInputValue("def_time").trim();
      await updateGuildConfig(gid, { $set: { "dynamicVC.defaultRecruitContent": defC, "dynamicVC.defaultRecruitTime": defT } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "recruit", updatedG));
    }

  }

  if (i.isAnySelectMenu()) {

    if (i.customId.startsWith("rmnu_str_") || i.customId.startsWith("rmnu_rol_")) {
      const isRole = i.customId.startsWith("rmnu_rol_");
      const vcId = i.customId.replace(isRole ? "rmnu_rol_" : "rmnu_str_", "");
      const token = Math.random().toString(36).substring(7);
      recruitSelections.set(token, i.values);
      return i.showModal(new ModalBuilder().setCustomId(`rmodal_${token}_${vcId}`).setTitle("メンバー募集").addComponents(
        createRow([new TextInputBuilder().setCustomId("content").setLabel("【募集内容】").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.defaultRecruitContent || "雑談").setRequired(true)]),
        createRow([new TextInputBuilder().setCustomId("time").setLabel("【日時】").setStyle(TextInputStyle.Short).setValue(g.dynamicVC.defaultRecruitTime || "いまから").setRequired(false)]),
        createRow([new TextInputBuilder().setCustomId("comment").setLabel("【一言】").setStyle(TextInputStyle.Paragraph).setRequired(false)])
      ));
    }

    if (i.customId.startsWith("vc_invite_select_")) {
      const vcId = i.customId.replace("vc_invite_select_", "");
      const vc = i.guild.channels.cache.get(vcId);
      if (!vc) return i.reply({ content: "❌ ボイスチャンネルが見つかりませんでした。", ephemeral: true });
      if (vcOwners.get(vc.id) !== i.user.id) return i.reply({ content: "❌ 部屋主のみが招待できます。", ephemeral: true });

      const userIds = i.values;
      if (userIds.length === 0) return i.reply({ content: "⚠️ メンバーが選択されていません。", ephemeral: true });

      await i.deferReply({ ephemeral: true });

      const invitedMentions = [];
      for (const uid of userIds) {
        await vc.permissionOverwrites.create(uid, {
          ViewChannel: true,
          Connect: true
        }).catch(console.error);
        invitedMentions.push(`<@${uid}>`);
      }

      await vc.send({
        content: `✨ ${invitedMentions.join(" ")} さんが <@${i.user.id}> にこの相談部屋へ招待されました！`
      }).catch(console.error);

      return i.editReply({ content: `✅ ${userIds.length} 名のメンバーを招待し、権限を付与しました！` });
    }

    if (i.customId.startsWith("vc_afk_select_")) {
      const targetUid = i.values[0];
      const member = await i.guild.members.fetch(targetUid).catch(() => null);
      if (!member || !member.voice.channelId) return i.reply({ content: "ユーザーがボイスチャンネルにいません。", ephemeral: true });
      if (!g.dynamicVC.afkChannelId) return i.reply({ content: "AFKチャンネルが設定されていません。", ephemeral: true });
      try {
        await member.voice.setChannel(g.dynamicVC.afkChannelId);
        return i.reply({ content: `✅ <@${targetUid}> をお布団へ運びました。`, ephemeral: true });
      } catch (e) {
        return i.reply({ content: `❌ 移動に失敗しました: ${e.message}`, ephemeral: true });
      }
    }

    if (i.customId.startsWith("select_cfg_relay_")) {
      const field = i.customId.replace("select_cfg_relay_", "");
      const val = i.values[0];
      if (field === "src") await updateGuildConfig(gid, { $set: { "dynamicVC.msgRelaySourceChannelId": val } });
      else if (field === "dst") await updateGuildConfig(gid, { $set: { "dynamicVC.msgRelayDestChannelId": val } });
      else if (field === "rpt") await updateGuildConfig(gid, { $set: { "dynamicVC.msgRelayReportUserId": val } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, "msg_relay", updatedG));
      return;
    }
    if (i.customId.startsWith("select_cfg_mc_")) {
      const field = i.customId.replace("select_cfg_mc_", "");
      const val = i.values[0];
      if (field === "main") {
        // 元のチャンネル名を保存
        const ch = i.guild.channels.cache.get(val);
        const origName = ch ? ch.name : null;
        const updateSet = { "dynamicVC.memberCountChannelId": val };
        if (origName) updateSet["dynamicVC.memberCountOriginalName"] = origName;
        await updateGuildConfig(gid, { $set: updateSet });
        const updatedG = await getGuildConfig(gid, true);
        await i.update(await getSettingsPayload(gid, "member_count", updatedG));
        await updateMemberCountChannels(i.guild);
      }
      return;
    }
    if (i.customId.startsWith("select_cfg_")) {
      const field = i.customId.replace("select_cfg_", ""), vals = i.values;
      if (field === "intro_add") {
        for (const uid of vals) await Intro.findOneAndUpdate({ guildId: gid, userId: uid }, { $set: { introduced: true } }, { upsert: true });
        return i.reply({ content: `✅ ${vals.length} 名を承認済みリストに手動追加しました。`, ephemeral: true });
      }
      const map = { trigger: "triggerChannelId", trigger4: "triggerChannelId4", trigger5: "triggerChannelId5", afk: "afkChannelId", panel: "createPanelChannelId", category: "cleanupCategoryId", introcheck: "introCheckChannelId", introsource: "introSourceChannelIds", male: "male", female: "female", recruit: "recruitmentChannelId", recruit_role: "recruitmentRoleIds" };
      const typeMap = { trigger: "trigger", trigger4: "trigger", trigger5: "trigger", afk: "afk", panel: "panel", category: "panel", introcheck: "intro_kick", introsource: "intro_display", male: "vc", female: "vc", recruit: "recruit", recruit_role: "recruit" };
      const type = typeMap[field] || "vc";
      if (field === "male" || field === "female") await updateGuildConfig(gid, { $set: { [`roles.${field}`]: vals[0] } });
      else if (map[field]) await updateGuildConfig(gid, { $set: { [`dynamicVC.${map[field]}`]: (field === "introsource" || field === "recruit_role") ? vals : vals[0] } });
      const updatedG = await getGuildConfig(gid, true);
      await i.update(await getSettingsPayload(gid, type, updatedG));
      if (field === "panel") await setupCreatePanel(gid);
    }
  }
});

// ─── VoiceStateUpdate ─────────────────────────────────────────────────────────
client.on(Events.VoiceStateUpdate, async (o, n) => {
  const gid = n.guild.id;
  const g = await getGuildConfig(gid);
  // vcSlotsベースのトリガーチャンネル一覧を構築
  const slots = g.dynamicVC.vcSlots || [];
  const slotMap = new Map(slots.map(s => [s.triggerChannelId, s]));

  if (n.channelId && slotMap.has(n.channelId) && g.features.vcCreationEnabled) {
    const slot = slotMap.get(n.channelId);
    const limit = slot.limit ?? 0;
    const name = slot.name.replace("{user}", n.member.displayName);
    try {
      const overwrites = [{ id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageWebhooks, PermissionFlagsBits.Connect, PermissionFlagsBits.MoveMembers] }];
      if (slot.isPrivate) {
        overwrites.push(
          { id: n.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: n.member.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] }
        );
      }
      const vc = await n.guild.channels.create({ name, type: ChannelType.GuildVoice, parent: g.dynamicVC?.cleanupCategoryId || n.channel.parentId, userLimit: limit, permissionOverwrites: overwrites });
      tempChannels.add(vc.id);
      vcOwners.set(vc.id, n.member.id);
      if (limit || slot.isFixed) limitLockedVCs.add(vc.id);
      if (slot.isPrivate) privateVCs.add(vc.id);
      await n.member.voice.setChannel(vc);
      await sendOrUpdateControlPanel(vc);
      const delMin = g.dynamicVC.autoDeleteMinutes || 5;
      setTimeout(() => checkAndCleanupVC(vc.id), delMin * 60 * 1000);
    } catch { }
    return;
  }
  if (n.channelId && tempChannels.has(n.channelId)) {
    const vc = n.channel, m = n.member, gender = genderMode.get(vc.id);
    if (g.features.genderRoleEnabled && gender && vcOwners.get(vc.id) !== m.id && !m.roles.cache.has(g.roles[gender])) {
      try { await m.voice.disconnect(); m.send((g.messages[gender === 'male' ? 'genderMaleOnlyDM' : 'genderFemaleOnlyDM'] || "").replace(/{vcName}/g, vc.name).replace(/\\n/g, '\n')).catch(() => { }); } catch { } return;
    }
    if (lockedVCs.has(vc.id) && vcOwners.get(vc.id) !== m.id && !allowedUsers.get(vc.id)?.has(m.id)) {
      try {
        await m.voice.disconnect();
        // 自動ノック
        if (!pendingRequests.has(vc.id)) pendingRequests.set(vc.id, new Map());
        if (!pendingRequests.get(vc.id).has(m.id)) {
          pendingRequests.get(vc.id).set(m.id, true);
          await updateKnockNotifyMessage(vc);
        }
      } catch { }
      return;
    }
    if (o.channelId !== n.channelId && g.features.vcIntroDisplayEnabled) {
      const bio = await Intro.findOne({ guildId: gid, userId: m.id });
      if (bio?.content) {
        if (!introPosted.has(vc.id)) introPosted.set(vc.id, new Set());
        if (!introPosted.get(vc.id).has(m.id)) {
          introPosted.get(vc.id).add(m.id);
          let msg = null;
          try {
            let webhook = null;
            const webhooks = await vc.fetchWebhooks();
            webhook = webhooks.find(wh => wh.owner && wh.owner.id === client.user.id);
            if (!webhook) webhook = await vc.createWebhook({ name: "VC Intro", avatar: client.user.displayAvatarURL() });

            const cleanName = m.displayName.replace(/<a?:.+?:\d+>|\p{Extended_Pictographic}/gu, "").replace(/[\u200B-\u200D\uFE0F]/g, "").trim() || m.displayName;
            const cleanContent = bio.content.replace(/<a?:.+?:\d+>|\p{Extended_Pictographic}/gu, "").replace(/[\u200B-\u200D\uFE0F]/g, "").trim();

            const embed = new EmbedBuilder().setColor(0x5865f2).setThumbnail(m.displayAvatarURL() || m.user.displayAvatarURL()).setDescription(`### ${cleanName}\n\n${cleanContent}`);

            if (webhook) {
              msg = await webhook.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            } else {
              msg = await vc.send({ embeds: [embed], flags: [MessageFlags.SuppressNotifications] });
            }
            // 自己紹介表示のあとにパネルを再配置
            await sendOrUpdateControlPanel(vc, true);
          } catch (e) {
            const cleanName = m.displayName.replace(/<a?:.+?:\d+>|\p{Extended_Pictographic}/gu, "").replace(/[\u200B-\u200D\uFE0F]/g, "").trim() || m.displayName;
            const cleanContent = bio.content.replace(/<a?:.+?:\d+>|\p{Extended_Pictographic}/gu, "").replace(/[\u200B-\u200D\uFE0F]/g, "").trim();
            msg = await vc.send({ embeds: [new EmbedBuilder().setColor(0x5865f2).setThumbnail(m.displayAvatarURL() || m.user.displayAvatarURL()).setDescription(`### ${cleanName}\n\n${cleanContent}`)], flags: [MessageFlags.SuppressNotifications] }).catch(() => null);
            await sendOrUpdateControlPanel(vc, true);
          }
          if (msg) introMsgIds.set(`${vc.id}_${m.id}`, msg.id);
        }
      }
    }
  }
  if (o.channelId && tempChannels.has(o.channelId) && o.channelId !== n.channelId) {
    const ch = o.channel, key = `${o.channelId}_${o.member.id}`; if (introMsgIds.has(key)) { try { await (await ch.messages.fetch(introMsgIds.get(key))).delete(); } catch { } introMsgIds.delete(key); introPosted.get(o.channelId)?.delete(o.member.id); }
    const realMembers = ch?.members.filter(m => !m.user.bot);
    if (realMembers?.size === 0) { try { await ch.delete(); [tempChannels, controlPanelMsgIds, lockedVCs, genderMode, vcOwners, pendingRequests, allowedUsers, knockNotifyMsgIds, renameTimestamps, introPosted, limitLockedVCs, recruitSelections, privateVCs].forEach(s => s.delete(o.channelId)); } catch { } }
    else if (ch && vcOwners.get(ch.id) === o.member.id) { const next = realMembers.first(); if (next) { vcOwners.set(ch.id, next.id); await sendOrUpdateControlPanel(ch, true); } }
  }
});

// ─── 自己紹介管理 ──────────────────────────────────────────────────────────
async function syncIntroHistory(gid) {
  const g = await getGuildConfig(gid);
  const checkChId = g.dynamicVC.introCheckChannelId, sourceChIds = g.dynamicVC.introSourceChannelIds || (g.dynamicVC.introSourceChannelId ? [g.dynamicVC.introSourceChannelId] : []);
  const guild = client.guilds.cache.get(gid); if (!guild) return;

  const scan = async (cid, isSource) => {
    const ch = guild.channels.cache.get(cid); if (!ch || !ch.isTextBased()) return;
    let lastId = null;
    while (true) {
      try {
        const msgs = await ch.messages.fetch({ limit: 100, before: lastId }); if (msgs.size === 0) break;
        for (const m of msgs.values()) {
          if (m.author.bot) continue;
          const data = isSource ? { content: (m.content + (m.attachments.size ? "\n" + m.attachments.map(a => a.url).join("\n") : "")).trim() } : { introduced: true };
          await Intro.findOneAndUpdate({ guildId: gid, userId: m.author.id }, { $set: data }, { upsert: true });
        }
        lastId = msgs.lastKey();
      } catch { break; }
    }
  };
  if (checkChId) await scan(checkChId, false);
  for (const sid of sourceChIds) await scan(sid, true);

  // ロール保持者を承認済みとして同期 (必要なロールを持つメンバーのみフェッチして軽量化)
  const roleIds = [g.roles?.male, g.roles?.female].filter(Boolean);
  if (roleIds.length > 0) {
    try {
      const members = await guild.members.fetch({ role: roleIds });
      for (const m of members.values()) {
        await Intro.findOneAndUpdate({ guildId: gid, userId: m.id }, { $set: { introduced: true } }, { upsert: true });
      }
    } catch (e) {
      console.error(`[SyncIntro] メンバー取得エラー (Guild: ${gid}): ${e.message}`);
    }
  }

  console.log(`🔄 Guild ${gid}: チャンネル履歴およびロールからの同期が完了しました。`);
}

const handleIntroUpdate = async (msg, type = "create") => {
  if (msg.author?.bot) return;
  const gid = msg.guildId; if (!gid) return;
  const g = await getGuildConfig(gid);
  const checkCh = g.dynamicVC.introCheckChannelId, sourceChs = g.dynamicVC.introSourceChannelIds || (g.dynamicVC.introSourceChannelId ? [g.dynamicVC.introSourceChannelId] : []);
  const isSource = sourceChs.includes(msg.channelId);
  if (msg.channelId !== checkCh && !isSource) return;

  const isDel = type === "delete", uid = msg.author.id;
  if (isDel) {
    if (isSource) await Intro.updateOne({ guildId: gid, userId: uid }, { $set: { content: "" } });
  } else {
    const introData = { guildId: gid, userId: uid };
    if (msg.channelId === checkCh) introData.introduced = true;
    if (isSource) introData.content = (msg.content + (msg.attachments.size ? "\n" + msg.attachments.map(a => a.url).join("\n") : "")).trim();
    const bio = await updateIntro(gid, uid, introData);
    if (type === "create" && msg.channelId === checkCh) {
      if (bio.warnMsgId) { try { await (await msg.guild.channels.cache.get(checkCh).messages.fetch(bio.warnMsgId)).delete(); } catch { } await Intro.updateOne({ _id: bio._id }, { $set: { warnMsgId: null } }); }
      // msg.reply({ content: (g.messages.introNotify || "✅ 確認").replace(/{user}/g, uid).replace(/\\n/g, '\n') }).then(r => setTimeout(() => r.delete().catch(() => { }), 10000));
    }
  }
};

client.on(Events.MessageCreate, m => handleIntroUpdate(m, "create"));
client.on(Events.MessageUpdate, (o, n) => handleIntroUpdate(n, "update"));
client.on(Events.MessageDelete, m => handleIntroUpdate(m, "delete"));

// ─── メッセージ転送 ──────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot || !msg.guild) return;
  const gid = msg.guild.id;
  const g = await getGuildConfig(gid);
  if (!g.features.msgRelayEnabled) return;
  const dvc = g.dynamicVC || {};
  if (!dvc.msgRelaySourceChannelId || !dvc.msgRelayDestChannelId) return;
  if (msg.channelId !== dvc.msgRelaySourceChannelId) return;

  // コンテンツ取得 & カットオフ処理
  let content = msg.content || "";
  if (dvc.msgRelayCutoff) {
    const lines = content.split("\n");
    const cutIdx = lines.findIndex(l => l.includes(dvc.msgRelayCutoff));
    if (cutIdx !== -1) content = lines.slice(0, cutIdx).join("\n");
  }
  content = content.trim();
  if (!content && msg.attachments.size === 0) return;

  const destCh = msg.guild.channels.cache.get(dvc.msgRelayDestChannelId);
  if (!destCh) return;

  try {
    // Webhookで投稿者の名前・アイコンで転送
    const webhooks = await destCh.fetchWebhooks();
    let webhook = webhooks.find(wh => wh.owner?.id === msg.client.user.id);
    if (!webhook) webhook = await destCh.createWebhook({ name: "MessageRelay", avatar: msg.client.user.displayAvatarURL() });
    await webhook.send({
      content: content || undefined,
      username: msg.member?.displayName || msg.author.username,
      avatarURL: msg.member?.displayAvatarURL({ dynamic: true }) || msg.author.displayAvatarURL(),
      files: [...msg.attachments.values()].map(a => a.url),
      flags: [MessageFlags.SuppressNotifications]
    });
  } catch (e) {
    console.error(`[MsgRelay] 転送エラー: ${e.message}`);
    const fallback = [`**${msg.member?.displayName || msg.author.username}**: ${content}`, ...[...msg.attachments.values()].map(a => a.url)].join("\n");
    await destCh.send({ content: fallback, flags: [MessageFlags.SuppressNotifications] }).catch(() => {});
  }

  // 報告ボタン付きメッセージを追加送信
  const reportRow = createRow([
    new ButtonBuilder()
      .setCustomId(`relay_rpt_${msg.author.id}`)
      .setLabel("⚠️ 問題を報告")
      .setStyle(ButtonStyle.Danger)
  ]);
  await destCh.send({
    content: `-# ↑ <@${msg.author.id}> の投稿`,
    components: [reportRow],
    flags: [MessageFlags.SuppressNotifications]
  }).catch(() => {});
});

// ─── 人数カウンター ───────────────────────────────────────────────────────────
const memberCountUpdateTimers = new Map();

async function updateMemberCountChannels(guild) {
  const gid = guild.id;
  const g = await getGuildConfig(gid);
  if (!g.features.memberCountEnabled) return;

  const roles = g.roles || {};
  const dynamicVC = g.dynamicVC || {};
  const chId = dynamicVC.memberCountChannelId;
  if (!chId) return;

  // ロールメンバー数を取得
  let maleCount = 0, femaleCount = 0, totalCount = guild.memberCount;
  try {
    const roleIds = [roles.male, roles.female].filter(Boolean);
    if (roleIds.length > 0) {
      // 全メンバーではなく特定のロールのみをフェッチ (超軽量)
      await guild.members.fetch({ role: roleIds });
      maleCount = roles.male ? (guild.roles.cache.get(roles.male)?.members.size || 0) : 0;
      femaleCount = roles.female ? (guild.roles.cache.get(roles.female)?.members.size || 0) : 0;
    }
    // BOTを除外した正確な合計を出すには全取得が必要なため、ここでは memberCount で代用
    // (頻繁な全取得はレートリミットの原因になるため)
  } catch (e) {
    console.error(`[MemberCount] メンバー取得エラー: ${e.message}`);
    maleCount = roles.male ? (guild.roles.cache.get(roles.male)?.members.size || 0) : 0;
    femaleCount = roles.female ? (guild.roles.cache.get(roles.female)?.members.size || 0) : 0;
  }

  // 1チャンネルに横並びで表示
  const totalSum = maleCount + femaleCount;
  const fmt = dynamicVC.memberCountFormat || "♂ {male}人・♀ {female}人・👤 {total}人";
  const name = fmt.replace("{male}", maleCount).replace("{female}", femaleCount).replace("{total}", totalSum);
  try {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (!ch) return;
    if (ch.name !== name) await ch.setName(name);
    // 一番上に移動 (ロックなし)
    await ch.setPosition(0).catch(() => { });
  } catch (e) {
    console.error(`[MemberCount] チャンネル更新エラー (${chId}): ${e.message}`);
  }
  console.log(`[MemberCount] ${guild.name}: ♂${maleCount} ♀${femaleCount} 👤${totalCount}`);
}

async function clearMemberCountChannels(guild) {
  const gid = guild.id;
  const g = await getGuildConfig(gid);
  const dynamicVC = g.dynamicVC || {};
  const chId = dynamicVC.memberCountChannelId;
  const origName = dynamicVC.memberCountOriginalName;
  if (!chId) return;

  try {
    const ch = await guild.channels.fetch(chId).catch(() => null);
    if (!ch) return;
    // 元の名前に戻す
    const restoreName = origName || "カウンター";
    if (ch.name !== restoreName) await ch.setName(restoreName);
    // 権限変更なし（ロックしていないため不要）
  } catch (e) {
    console.error(`[MemberCount] チャンネル復元エラー (${chId}): ${e.message}`);
  }
  console.log(`[MemberCount] ${guild.name}: カウンター無効化 - チャンネルを復元しました`);
}

function scheduleMemberCountUpdate(guild) {
  // レート制限を避けるため5秒後にまとめて更新
  if (memberCountUpdateTimers.has(guild.id)) clearTimeout(memberCountUpdateTimers.get(guild.id));
  const timer = setTimeout(() => { memberCountUpdateTimers.delete(guild.id); updateMemberCountChannels(guild); }, 5000);
  memberCountUpdateTimers.set(guild.id, timer);
}

client.on(Events.GuildMemberAdd, (member) => scheduleMemberCountUpdate(member.guild));
client.on(Events.GuildMemberRemove, (member) => scheduleMemberCountUpdate(member.guild));
// ロール変更を確実に捕捉するため、すべてのメンバー更新でトリガー
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
  scheduleMemberCountUpdate(newMember.guild);
});

// ─── 起動処理 ────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);

  // スラッシュコマンドの登録 (全サーバー一括)
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("📝 スラッシュコマンドを登録中...");
    const commandsData = allCommands.map(c => c.data.toJSON());
    await rest.put(Routes.applicationCommands(client.user.id), { body: commandsData });
    console.log("✅ スラッシュコマンドの登録が完了しました。");
  } catch (err) { console.error("❌ コマンド登録エラー:", err); }

  const guilds = client.guilds.cache;
  for (const guild of guilds.values()) {
    const gid = guild.id;
    const g = await getGuildConfig(gid);
    await setupSettingsPanel(gid);
    await setupCreatePanel(gid);
    await syncIntroHistory(gid);
    await updateMemberCountChannels(guild);
    
    // サーバー間の処理に少し間隔を置く (起動時のバーストによるレートリミット対策)
    await new Promise(resolve => setTimeout(resolve, 3000));
    if (fs.existsSync("./introDB.json")) {
      try {
        const localIntro = JSON.parse(fs.readFileSync("./introDB.json", "utf-8"));
        let migratedCount = 0;
        if (localIntro[gid]) {
          for (const [uid, data] of Object.entries(localIntro[gid])) {
            if (typeof data === "object") {
              const existing = await Intro.findOne({ guildId: gid, userId: uid });
              if (!existing) { await Intro.create({ guildId: gid, userId: uid, ...data }); migratedCount++; }
            }
          }
        }
        if (gid === guildId) {
          for (const [uid, data] of Object.entries(localIntro)) {
            if (uid.length > 15 && typeof data === "object" && !localIntro[uid]) {
              const existing = await Intro.findOne({ guildId: gid, userId: uid });
              if (!existing) { await Intro.create({ guildId: gid, userId: uid, ...data }); migratedCount++; }
            }
          }
        }
        if (migratedCount > 0) console.log(`📦 Guild ${gid}: ${migratedCount} 件 of 自己紹介データを移行しました。`);
      } catch (err) { console.error("❌ 自己紹介データ移行エラー:", err); }
    }

    // 定期チェック (自己紹介キック)
    setInterval(async () => {
      try {
        const gCurrent = await getGuildConfig(guild.id);
        if (!gCurrent.features.introKickEnabled) return;
        const checkChId = gCurrent.dynamicVC.introCheckChannelId;
        if (!checkChId) return;
        const checkCh = guild.channels.cache.get(checkChId);
        if (!checkCh) return;

        // 全メンバーフェッチはレート制限の原因になるため、キャッシュを使用
        const members = guild.members.cache;
        const now = Date.now();
        for (const m of members.values()) {
          if (m.user.bot || !m.joinedTimestamp) continue;

          // ロールをすでに持っている場合は承認済み扱い
          if (m.roles.cache.has(gCurrent.roles?.male) || m.roles.cache.has(gCurrent.roles?.female)) {
            await Intro.findOneAndUpdate({ guildId: guild.id, userId: m.id }, { $set: { introduced: true } }, { upsert: true });
            continue;
          }

          const bio = await Intro.findOne({ guildId: guild.id, userId: m.id });
          if (bio?.introduced) continue;

          const elapsed = now - m.joinedTimestamp;
          const warn = (gCurrent.dynamicVC.introWarnMinutes || 2880) * 60000;
          const kick = (gCurrent.dynamicVC.introKickMinutes || 4320) * 60000;

          if (elapsed >= kick) {
            try { await m.send(gCurrent.messages.introKickDM.replace(/\\n/g, '\n')).catch(() => { }); } catch { }
            await m.kick("自己紹介未記入による自動退出").catch(() => { });
            await Intro.updateOne({ guildId: guild.id, userId: m.id }, { $set: { kicked: true } }, { upsert: true });
          }
          else if (elapsed >= warn && !bio?.warned) {
            try {
              const w = await checkCh.send(gCurrent.messages.introWarnMsg.replace(/{user}/g, m.id).replace(/{leftMinutes}/g, Math.floor((kick - elapsed) / 60000)).replace(/\\n/g, '\n'));
              await updateIntro(guild.id, m.id, { warned: true, warnMsgId: w.id });
              setTimeout(() => w.delete().catch(() => { }), Math.max(0, kick - elapsed));
            } catch (e) { console.error(`[KickWarn] Error in ${guild.name}:`, e.message); }
          }
        }
      } catch (err) { console.error(`[IntroKick] Error in ${guild.id}:`, err); }
    }, 60000); // 60秒ごとにチェック (負荷軽減)
  }
});

client.login(token);
