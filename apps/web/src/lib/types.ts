/** Formatos devolvidos pela API (espelham o Prisma, já sem segredos). */

export type QualityRating = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
export type NumberRole = 'ATTENDANCE' | 'CAMPAIGNS' | 'BOTH';

export interface PhoneNumber {
  id: string;
  phoneNumberId: string;
  wabaId: string;
  displayName: string;
  displayPhone: string | null;
  role: NumberRole;
  status: string;
  qualityRating: QualityRating;
  messagingTier: string | null;
  dailyConversationLimit: number;
  baseSendRatePerMinute: number;
  sendRatePerMinute: number;
  botEnabled: boolean;
  campaignsPaused: boolean;
  isActive: boolean;
  hasOwnToken: boolean;
  lastSyncedAt: string | null;
  createdAt: string;
  stats: { sentToday: number; sentMonth: number; activeCampaigns: number; unreadAlerts: number };
}

export interface Alert {
  id: string;
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  type: string;
  message: string;
  phoneNumberId: string | null;
  createdAt: string;
}

export interface Dashboard {
  numbers: PhoneNumber[];
  alerts: Alert[];
  totals: { contacts: number; optOuts: number; awaitingReply: number; templates: Record<string, number> };
  bot: { enabled: boolean; mode: 'echo' | 'ai' | 'off' };
}

export interface Template {
  id: string;
  wabaId: string;
  name: string;
  language: string;
  category: string;
  status: string;
  rejectedReason: string | null;
  syncedAt: string;
  variables: { header: number; body: number };
  preview: string;
  components: { type: string; format?: string; text?: string }[];
}

export interface AuthStatus {
  setupRequired: boolean;
  user: { id: string; email: string; name: string; role: UserRole; twoFactor: boolean } | null;
}

export type UserRole = 'ADMIN' | 'ATENDENTE';

export interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  twoFactor: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  openConversations: number;
  me: boolean;
  phone: string | null;
  alertNewOrders: boolean;
  alertStuck: boolean;
  alertDaily: boolean;
}

export interface Assignee {
  id: string;
  name: string;
}

export interface Tag {
  id: string;
  name: string;
  color: string | null;
  contacts?: number;
}

export interface ContactListItem {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  optIn: boolean;
  optInAt: string | null;
  optInSource: string | null;
  optOut: boolean;
  optOutAt: string | null;
  lastInboundAt: string | null;
  tags: Tag[];
}

export interface ConsentLog {
  id: string;
  action: 'OPT_IN' | 'OPT_OUT';
  source: string;
  detail: string | null;
  createdAt: string;
}

export interface ContactDetail extends ContactListItem {
  document: string | null;
  createdAt: string;
  consentLogs: ConsentLog[];
  conversations: { id: string; handler: 'BOT' | 'HUMAN'; lastMessageAt: string | null; phoneNumber: { id: string; displayName: string } }[];
}

export interface ImportReport {
  totalLines: number;
  valid: number;
  created: number;
  updated: number;
  optInMarked: number;
  skippedOptOut: number;
  rejected: { line: number; value: string; reason: string }[];
  columns: Record<string, string | null>;
  preview: { line: number; name: string | null; phone: string; email: string | null; tags: string[]; optIn: boolean }[];
  dryRun: boolean;
}

export type Handler = 'BOT' | 'HUMAN';
export type SenderKind = 'CONTACT' | 'BOT' | 'HUMAN' | 'SYSTEM' | 'CAMPAIGN';
export type MessageStatus = 'RECEIVED' | 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

export interface ConversationListItem {
  id: string;
  handler: Handler;
  unreadCount: number;
  awaitingReply: boolean;
  lastMessageAt: string | null;
  windowOpen: boolean;
  contact: { id: string; name: string | null; phone: string; optOut: boolean };
  phoneNumber: { id: string; displayName: string };
  assignedTo: Assignee | null;
  lastMessage: { body: string | null; type: string; direction: 'INBOUND' | 'OUTBOUND'; sentBy: SenderKind; status: MessageStatus; createdAt: string } | null;
}

export interface ConversationList {
  conversations: ConversationListItem[];
  nextCursor: string | null;
  counts: { bot: number; human: number; awaiting: number; unread: number; mine: number };
}

export interface ConversationDetail {
  id: string;
  handler: Handler;
  handoffReason: string | null;
  assignedTo: Assignee | null;
  windowOpen: boolean;
  windowClosesAt: string | null;
  contact: ContactListItem;
  phoneNumber: { id: string; displayName: string; displayPhone: string | null; wabaId: string; botEnabled: boolean };
}

export interface ChatMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  type: string;
  body: string | null;
  mediaId: string | null;
  mediaMime: string | null;
  filename: string | null;
  templateName: string | null;
  status: MessageStatus;
  errorMessage: string | null;
  sentBy: SenderKind;
  sentByName: string | null;
  createdAt: string;
}

export interface QuickReply {
  id: string;
  shortcut: string;
  title: string;
  body: string;
}

// ── Bling / Produtos ──
export interface BlingSyncResult {
  listed: number;
  created: number;
  updated: number;
  details: number;
  deactivated: number;
  calls: number;
  ms: number;
}

export interface BlingStatus {
  configured: boolean;
  connected: boolean;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  lastRefreshAt: string | null;
  redirectUri: string;
  intervalMinutes: number;
  sync: {
    running: boolean;
    startedAt?: string;
    finishedAt?: string;
    ok?: boolean;
    error?: string;
    trigger?: string;
    result?: BlingSyncResult;
  };
  products: { total: number; active: number; inStock: number };
}

export interface ProductItem {
  id: string;
  blingId: string;
  sku: string | null;
  name: string;
  price: number;
  stock: number;
  format: string | null;
  category: string | null;
  gender: string | null;
  shortDescription: string | null;
  imageUrl: string | null;
  active: boolean;
  syncedAt: string;
}

export interface ProductDetail extends ProductItem {
  descriptionText: string | null;
  descriptionHtml: string | null;
  categoryId: string | null;
  parentBlingId: string | null;
  detailSyncedAt: string | null;
}

export interface OrderSummary {
  id: string;
  numero: number;
  numeroLoja: string | null;
  data: string | null;
  dataSaida: string | null;
  dataPrevista: string | null;
  situacao: string;
  total: number;
  frete: number | null;
  itens: { descricao: string; quantidade: number; valor: number }[];
  transportadora: string | null;
  rastreios: string[];
  notaFiscalEmitida: boolean;
  cliente: string;
}

export interface ContactBlingInfo {
  linked: boolean;
  conflictContactId?: string | null;
  blingContact: { id: string; nome: string; numeroDocumento: string | null } | null;
  orders: OrderSummary[];
  hint?: string;
}

// ── Bot de IA ──
export interface BotToolCall {
  name: string;
  input: unknown;
  ok: boolean;
  outcome: 'ok' | 'not_found' | 'error';
  ms: number;
}

export interface BotLogItem {
  id: string;
  conversationId: string | null;
  simSessionId: string | null;
  simulated: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolsCalled: BotToolCall[];
  replyText: string | null;
  latencyMs: number;
  error: string | null;
  iterations: number;
  stopReason: string | null;
  handoff: boolean;
  createdAt: string;
  conversation?: { id: string; contact: { id: string; name: string | null; phone: string } } | null;
}

export interface SimMessage {
  role: 'user' | 'assistant' | 'system';
  text: string;
  imageUrl?: string;
  at: string;
}

export interface SimSession {
  id: string;
  customerName: string | null;
  phone: string;
  document: string | null;
  messages: SimMessage[];
  summary: string | null;
  handedOff: boolean;
  handoffReason: string | null;
  failedAttempts: number;
  createdAt: string;
  logs: BotLogItem[];
}

export type DayKey = '0' | '1' | '2' | '3' | '4' | '5' | '6';
export interface BusinessHours {
  timezone: string;
  days: Partial<Record<DayKey, [string, string]>>;
  closedDates: string[];
}

export interface BotSettings {
  enabled: boolean;
  mode: 'echo' | 'ai' | 'off';
  model: string;
  effort: string;
  apiKey: { configured: boolean; source: 'painel' | 'env' | null; last4: string | null };
  businessHours: BusinessHours;
  hoursDescription: string;
  humanOpenNow: boolean;
  nextOpening: string | null;
  maxFailedAttempts: number;
  debounceMs: number;
  numbers: { id: string; displayName: string; displayPhone: string | null; botEnabled: boolean; role: 'ATTENDANCE' | 'CAMPAIGNS' | 'BOTH'; isActive: boolean }[];
}

export interface KnowledgeInfo {
  content: string;
  source: 'painel' | 'arquivo' | 'vazio';
  updatedAt: string | null;
  versionId: string | null;
  maxChars: number;
  pending: string[];
  versions: { id: string; note: string | null; createdAt: string }[];
}

// ── Campanhas ──

export type CampaignStatus = 'DRAFT' | 'SCHEDULED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'CANCELED';

export type VariableSource =
  | { source: 'firstName'; fallback: string }
  | { source: 'fullName'; fallback: string }
  | { source: 'text'; value: string }
  | { source: 'product'; productId: string; field: 'name' | 'price' };

export interface VariableMap {
  header: VariableSource[];
  body: VariableSource[];
}

export interface CampaignSegment {
  search?: string;
  tagsAny: string[];
  tagsAll: string[];
  excludeTags: string[];
  inactiveDays?: number;
}

export interface CampaignBase {
  id: string;
  name: string;
  status: CampaignStatus;
  phoneNumberId: string;
  templateId: string;
  headerMediaUrl: string | null;
  /** 'painel' = veio do painel do site (precisa da aprovação de um administrador) */
  source?: string | null;
  scheduledAt: string | null;
  scheduledLocal: string | null;
  timezone: string;
  windowStartHour: number;
  windowEndHour: number;
  startedAt: string | null;
  finishedAt: string | null;
  pausedReason: string | null;
  pausedAt: string | null;
  waitingReason: string | null;
  lastError: string | null;
  totalRecipients: number;
  createdAt: string;
  phoneNumber: { id: string; displayName: string; displayPhone: string | null };
  template: { id: string; name: string; language: string; category: string; status: string };
}

export interface CampaignListItem extends CampaignBase {
  counts: { total: number; pending: number; sent: number; failed: number; replied: number; skipped: number };
}

export interface CampaignCounts {
  total: number;
  pending: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  optOuts: number;
  skipped: number;
}

export interface CampaignDetail {
  campaign: CampaignBase & { segment: CampaignSegment; variables: VariableMap };
  counts: CampaignCounts;
  skipReasons: { reason: string; label: string; count: number }[];
  failures: { message: string; count: number }[];
  number: { id: string; displayName: string; qualityRating: QualityRating; sendRatePerMinute: number; dailyCap: number; blockReason: string | null };
  templateShape: { headerVars: number; bodyVars: number; headerMedia: 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null };
}

export interface CampaignEstimate {
  total: number;
  eligible: number;
  minDaysBetween: number;
  excluded: { reason: string; label: string; count: number }[];
  sample: { id: string; name: string | null; phone: string }[];
  timing: { ratePerMinute: number; dailyCap: number; windowHours: number; perDay: number; days: number; minutesFirstDay: number; limitedBy: string } | null;
}

export interface CampaignPreview {
  contact: { id: string; name: string | null; phone: string } | null;
  text: string;
  headerMedia: { format: string; url: string | null } | null;
}

export interface CampaignRecipientRow {
  id: string;
  status: string;
  skipReason: string | null;
  errorMessage: string | null;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  repliedAt: string | null;
  optedOutAt: string | null;
  contact: { id: string; name: string | null; phone: string };
}
