/* eslint-disable no-await-in-loop, no-continue, @typescript-eslint/no-unsafe-type-assertion */
import { readFile } from 'node:fs/promises';

import { PrismaClient, SplitType } from '@prisma/client';
import { nanoid } from 'nanoid';

import { CURRENCIES, type CurrencyCode, isCurrencyCode } from './currency.js';

const SPLITWISE_API_BASE = 'https://secure.splitwise.com/api/v3.0';
const IMPORT_PREFIX = 'splitwise:';
const PAGE_LIMIT = 100;
const USER_MAP_PATH = 'splitwise-user-map.json';
const DEFAULT_CATEGORY = 'general';

const db = new PrismaClient({ log: ['error', 'warn'] });

type Mode = 'dry-run' | 'commit' | 'delete-imported' | 'list-splitpro-users';
type UserResolutionMethod = 'mapping' | 'email' | 'create' | 'unresolved';

interface Args {
  mode: Mode;
  yes: boolean;
  createMissingUsers: boolean;
}

interface SplitwiseUser {
  id: number;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

interface SplitwiseGroup {
  id: number;
  name: string;
  members: SplitwiseUser[];
  default_currency?: string | null;
}

interface SplitwiseExpenseUser {
  id?: number | null;
  user_id?: number | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  user?: SplitwiseUser | null;
  paid_share: string;
  owed_share: string;
  net_balance?: string;
}

interface SplitwiseCategory {
  name?: string | null;
}

interface SplitwiseExpense {
  id: number;
  group_id?: number | null;
  friendship_id?: number | null;
  description?: string | null;
  details?: string | null;
  cost: string;
  currency_code?: string | null;
  date?: string | null;
  created_at?: string | null;
  deleted_at?: string | null;
  deleted_by?: SplitwiseUser | null;
  payment?: boolean;
  category?: SplitwiseCategory | null;
  users: SplitwiseExpenseUser[];
}

interface MappingEntry {
  splitProUserId: string | number;
  note?: string;
}

type UserMapFile = Record<string, MappingEntry>;

interface MoneyTotals {
  paid: bigint;
  owed: bigint;
}

interface PlannedUser {
  splitwiseId: number;
  email?: string;
  name: string;
  groups: string[];
  totalsByCurrency: Map<CurrencyCode, MoneyTotals>;
  mappedUserId?: number;
  existingUserId?: number;
  splitProUserId?: number;
  resolutionMethod: UserResolutionMethod;
  mappingNote?: string;
}

interface PlannedGroup {
  splitwiseId: number;
  name: string;
  memberSplitwiseIds: number[];
  existingId?: number;
  defaultCurrency?: CurrencyCode;
}

interface PlannedParticipant {
  splitwiseUserId: number;
  amount: bigint;
}

interface PlannedExpense {
  splitwiseId: number;
  transactionId: string;
  groupSplitwiseId?: number;
  paidBySplitwiseId: number;
  name: string;
  amount: bigint;
  currency: CurrencyCode;
  category: string;
  splitType: SplitType;
  expenseDate: Date;
  participants: PlannedParticipant[];
  note: string;
}

interface Skip {
  splitwiseExpenseId?: number;
  reason: string;
  payerDebug?: PayerDebug;
}

interface RawUserDebug {
  id?: number | null;
  userId?: number | null;
  nestedUserId?: number | null;
  name: string;
  email?: string | null;
  paidShare: string;
  owedShare: string;
  netBalance?: string;
}

interface PayerCandidateDebug {
  splitwiseUserId?: number;
  name: string;
  email?: string | null;
  paidShare: string;
  paidShareMinor?: string;
  isPayer: boolean;
}

interface PayerDebug {
  expenseId: number;
  description?: string | null;
  cost: string;
  currency?: string | null;
  totalPaidMinor: string;
  totalOwedMinor: string;
  costMinor: string;
  rawUsers: RawUserDebug[];
  payerCandidates: PayerCandidateDebug[];
}

interface Plan {
  currentSplitwiseUserId: number;
  currentUserId?: number;
  createMissingUsers: boolean;
  users: PlannedUser[];
  groups: PlannedGroup[];
  expenses: PlannedExpense[];
  skips: Skip[];
  existingExpenseCount: number;
}

const parseArgs = (): Args => {
  const rawArgs = new Set(process.argv.slice(2));
  const dryRun = rawArgs.has('--dry-run');
  const commit = rawArgs.has('--commit');
  const deleteImported = rawArgs.has('--delete-imported');
  const listSplitProUsers = rawArgs.has('--list-splitpro-users');

  if ([dryRun, commit, deleteImported, listSplitProUsers].filter(Boolean).length !== 1) {
    throw new Error(
      'Choose exactly one mode: --dry-run, --commit, --delete-imported, or --list-splitpro-users.',
    );
  }

  return {
    mode: dryRun
      ? 'dry-run'
      : commit
        ? 'commit'
        : deleteImported
          ? 'delete-imported'
          : 'list-splitpro-users',
    yes: rawArgs.has('--yes'),
    createMissingUsers: rawArgs.has('--create-missing-users'),
  };
};

const getToken = () => {
  const token = process.env.SPLITWISE_ACCESS_TOKEN ?? process.env.SPLITWISE_API_KEY;
  if (!token) {
    throw new Error('Set SPLITWISE_ACCESS_TOKEN or SPLITWISE_API_KEY.');
  }
  return token;
};

const ensureDatabaseUrl = () => {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL.');
  }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseUserId = (value: string | number, splitwiseUserId: string) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(
      `${USER_MAP_PATH} entry ${splitwiseUserId} has invalid splitProUserId "${value}". Expected numeric User.id.`,
    );
  }
  return id;
};

function assertMappingEntry(
  splitwiseUserId: string,
  entry: unknown,
): asserts entry is MappingEntry {
  if (!isPlainObject(entry)) {
    throw new Error(`${USER_MAP_PATH} entry ${splitwiseUserId} must be an object.`);
  }
  if (!('splitProUserId' in entry)) {
    throw new Error(`${USER_MAP_PATH} entry ${splitwiseUserId} is missing splitProUserId.`);
  }
  if (typeof entry.splitProUserId !== 'string' && typeof entry.splitProUserId !== 'number') {
    throw new Error(
      `${USER_MAP_PATH} entry ${splitwiseUserId} has invalid splitProUserId. Expected string or number.`,
    );
  }
  if ('note' in entry && typeof entry.note !== 'string' && typeof entry.note !== 'undefined') {
    throw new Error(`${USER_MAP_PATH} entry ${splitwiseUserId} has invalid note.`);
  }
}

const readUserMap = async (): Promise<Map<number, { splitProUserId: number; note?: string }>> => {
  try {
    const raw = await readFile(USER_MAP_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isPlainObject(parsed)) {
      throw new Error(`${USER_MAP_PATH} must contain a JSON object.`);
    }
    const map = new Map<number, { splitProUserId: number; note?: string }>();

    for (const [splitwiseUserId, entry] of Object.entries(parsed)) {
      assertMappingEntry(splitwiseUserId, entry);
      const id = Number(splitwiseUserId);
      if (!Number.isInteger(id) || id <= 0) {
        throw new Error(
          `${USER_MAP_PATH} contains invalid Splitwise user id "${splitwiseUserId}".`,
        );
      }
      map.set(id, {
        splitProUserId: parseUserId(entry.splitProUserId, splitwiseUserId),
        note: entry.note,
      });
    }

    return map;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return new Map();
    }
    throw error;
  }
};

const splitwiseGet = async <T>(path: string, token: string, params?: Record<string, string>) => {
  const url = new URL(`${SPLITWISE_API_BASE}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Splitwise API ${path} failed: ${response.status} ${body}`);
  }

  return (await response.json()) as T;
};

const fetchSplitwiseData = async (token: string) => {
  const [{ user }, { groups }] = await Promise.all([
    splitwiseGet<{ user: SplitwiseUser }>('/get_current_user', token),
    splitwiseGet<{ groups: SplitwiseGroup[] }>('/get_groups', token),
  ]);

  const expenses: SplitwiseExpense[] = [];
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const page = await splitwiseGet<{ expenses: SplitwiseExpense[] }>('/get_expenses', token, {
      limit: String(PAGE_LIMIT),
      offset: String(offset),
      visible: 'false',
    });
    expenses.push(...page.expenses);
    if (page.expenses.length < PAGE_LIMIT) {
      break;
    }
  }

  return { currentUser: user, groups, expenses };
};

const displayName = (user: SplitwiseUser) =>
  [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
  user.email ||
  `Splitwise user ${user.id}`;

const expenseUserIdentity = (expenseUser: SplitwiseExpenseUser): SplitwiseUser | undefined => {
  const splitwiseUserId = expenseUser.user_id ?? expenseUser.id ?? expenseUser.user?.id;
  if (typeof splitwiseUserId !== 'number') {
    return undefined;
  }

  const user = expenseUser.user ?? expenseUser;
  return {
    id: splitwiseUserId,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
  };
};

const currencyOrSkip = (currency: string | null | undefined): CurrencyCode | undefined => {
  if (!currency || !isCurrencyCode(currency)) {
    return undefined;
  }
  return currency;
};

const decimalToMinor = (value: string, currency: CurrencyCode) => {
  if (!/^-?\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal amount "${value}"`);
  }

  const decimals = CURRENCIES[currency].decimalDigits;
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  const padded = fraction.padEnd(decimals + 1, '0');
  const keptFraction = padded.slice(0, decimals);
  const roundingDigit = Number(padded[decimals] ?? '0');
  let amount = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(keptFraction || '0');
  if (roundingDigit >= 5) {
    amount += 1n;
  }
  return negative ? -amount : amount;
};

const getPayerCandidates = (expense: SplitwiseExpense, currency: CurrencyCode) =>
  expense.users
    .map((user) => {
      const identity = expenseUserIdentity(user);
      return {
        splitwiseUserId: identity?.id,
        name: identity ? displayName(identity) : '(unable to derive user identity)',
        email: identity?.email,
        paidShareRaw: user.paid_share,
        paidShareMinor: decimalToMinor(user.paid_share, currency),
      };
    })
    .filter((user) => user.paidShareMinor > 0n);

const findSinglePayer = (expense: SplitwiseExpense, currency: CurrencyCode) => {
  const payers = getPayerCandidates(expense, currency);

  return payers.length === 1 && typeof payers[0]?.splitwiseUserId === 'number'
    ? { splitwiseUserId: payers[0].splitwiseUserId, paidShare: payers[0].paidShareMinor }
    : undefined;
};

const buildPayerDebug = (expense: SplitwiseExpense, currency: CurrencyCode): PayerDebug => ({
  expenseId: expense.id,
  description: expense.description,
  cost: expense.cost,
  currency: expense.currency_code,
  totalPaidMinor: expense.users
    .reduce((sum, user) => sum + decimalToMinor(user.paid_share, currency), 0n)
    .toString(),
  totalOwedMinor: expense.users
    .reduce((sum, user) => sum + decimalToMinor(user.owed_share, currency), 0n)
    .toString(),
  costMinor: decimalToMinor(expense.cost, currency).toString(),
  rawUsers: expense.users.map((expenseUser) => {
    const nestedUser = expenseUser.user;
    const identity = expenseUserIdentity(expenseUser);
    return {
      id: expenseUser.id,
      userId: expenseUser.user_id,
      nestedUserId: nestedUser?.id,
      name: identity ? displayName(identity) : '(unable to derive user identity)',
      email: identity?.email,
      paidShare: expenseUser.paid_share,
      owedShare: expenseUser.owed_share,
      netBalance: expenseUser.net_balance,
    };
  }),
  payerCandidates: expense.users.map((expenseUser) => {
    const identity = expenseUserIdentity(expenseUser);
    const paidShareMinor = (() => {
      try {
        return decimalToMinor(expenseUser.paid_share, currency).toString();
      } catch {
        return undefined;
      }
    })();

    return {
      splitwiseUserId: identity?.id,
      name: identity ? displayName(identity) : '(unable to derive user identity)',
      email: identity?.email,
      paidShare: expenseUser.paid_share,
      paidShareMinor,
      isPayer: paidShareMinor ? BigInt(paidShareMinor) > 0n : false,
    };
  }),
});

const buildNote = (expense: SplitwiseExpense) =>
  [
    `Imported from Splitwise expense ${expense.id}.`,
    expense.details ? `Splitwise details: ${expense.details}` : undefined,
    expense.group_id ? `Splitwise group ID: ${expense.group_id}` : undefined,
    expense.friendship_id ? `Splitwise friendship ID: ${expense.friendship_id}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');

const upsertSplitwiseUser = (usersBySplitwiseId: Map<number, PlannedUser>, user: SplitwiseUser) => {
  const existing = usersBySplitwiseId.get(user.id);
  const email = user.email ?? existing?.email;
  const name = displayName(user);

  if (existing) {
    existing.email = email;
    if (name !== `Splitwise user ${user.id}`) {
      existing.name = name;
    }
    return existing;
  }

  const plannedUser: PlannedUser = {
    splitwiseId: user.id,
    email,
    name,
    groups: [],
    totalsByCurrency: new Map(),
    resolutionMethod: 'unresolved',
  };
  usersBySplitwiseId.set(user.id, plannedUser);
  return plannedUser;
};

const addUserGroup = (user: PlannedUser, groupName: string) => {
  if (!user.groups.includes(groupName)) {
    user.groups.push(groupName);
  }
};

const addUserTotals = (
  user: PlannedUser,
  currency: CurrencyCode,
  paidShare: bigint,
  owedShare: bigint,
) => {
  const totals = user.totalsByCurrency.get(currency) ?? { paid: 0n, owed: 0n };
  totals.paid += paidShare;
  totals.owed += owedShare;
  user.totalsByCurrency.set(currency, totals);
};

const collectUsers = (
  currentUser: SplitwiseUser,
  groups: SplitwiseGroup[],
  expenses: SplitwiseExpense[],
) => {
  const usersBySplitwiseId = new Map<number, PlannedUser>();
  upsertSplitwiseUser(usersBySplitwiseId, currentUser);

  const groupNameById = new Map(groups.map((group) => [group.id, group.name]));
  for (const group of groups) {
    for (const member of group.members) {
      addUserGroup(upsertSplitwiseUser(usersBySplitwiseId, member), group.name);
    }
  }

  for (const expense of expenses) {
    const groupName = expense.group_id
      ? (groupNameById.get(expense.group_id) ?? `Splitwise group ${expense.group_id}`)
      : 'Non-group expenses';
    const currency = currencyOrSkip(expense.currency_code);

    for (const expenseUser of expense.users) {
      const user = expenseUserIdentity(expenseUser);
      if (!user) {
        continue;
      }

      const plannedUser = upsertSplitwiseUser(usersBySplitwiseId, user);
      addUserGroup(plannedUser, groupName);
      if (currency) {
        addUserTotals(
          plannedUser,
          currency,
          decimalToMinor(expenseUser.paid_share, currency),
          decimalToMinor(expenseUser.owed_share, currency),
        );
      }
    }
  }

  return [...usersBySplitwiseId.values()].sort((a, b) => a.splitwiseId - b.splitwiseId);
};

const resolveUsers = async (
  users: PlannedUser[],
  userMap: Map<number, { splitProUserId: number; note?: string }>,
  createMissingUsers: boolean,
) => {
  const explicitUserIds = [...new Set([...userMap.values()].map((entry) => entry.splitProUserId))];
  const mappedUsers = await db.user.findMany({
    where: { id: { in: explicitUserIds } },
    select: { id: true },
  });
  const existingMappedUserIds = new Set(mappedUsers.map((user) => user.id));

  for (const [splitwiseUserId, entry] of userMap) {
    if (!existingMappedUserIds.has(entry.splitProUserId)) {
      throw new Error(
        `${USER_MAP_PATH} maps Splitwise user ${splitwiseUserId} to missing Split Pro User.id ${entry.splitProUserId}.`,
      );
    }
  }

  const emails = users.map((user) => user.email).filter((email): email is string => Boolean(email));
  const existingUsers = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  const userIdByEmail = new Map(existingUsers.map((user) => [user.email, user.id]));

  for (const user of users) {
    const mapped = userMap.get(user.splitwiseId);
    if (mapped) {
      user.mappedUserId = mapped.splitProUserId;
      user.splitProUserId = mapped.splitProUserId;
      user.resolutionMethod = 'mapping';
      user.mappingNote = mapped.note;
      continue;
    }

    const existingUserId = user.email ? userIdByEmail.get(user.email) : undefined;
    if (existingUserId) {
      user.existingUserId = existingUserId;
      user.splitProUserId = existingUserId;
      user.resolutionMethod = 'email';
      continue;
    }

    if (createMissingUsers) {
      user.resolutionMethod = 'create';
      continue;
    }

    user.resolutionMethod = 'unresolved';
  }
};

const buildPlan = async (
  currentUser: SplitwiseUser,
  splitwiseGroups: SplitwiseGroup[],
  splitwiseExpenses: SplitwiseExpense[],
  createMissingUsers: boolean,
): Promise<Plan> => {
  const skips: Skip[] = [];
  const userMap = await readUserMap();
  const users = collectUsers(currentUser, splitwiseGroups, splitwiseExpenses);
  await resolveUsers(users, userMap, createMissingUsers);

  const usersBySplitwiseId = new Map(users.map((user) => [user.splitwiseId, user]));
  const currentPlannedUser = usersBySplitwiseId.get(currentUser.id);
  if (!currentPlannedUser) {
    throw new Error('Current Splitwise user was not present in the fetched data.');
  }

  const existingGroups = await db.group.findMany({
    where: { splitwiseGroupId: { in: splitwiseGroups.map((group) => String(group.id)) } },
    select: { id: true, splitwiseGroupId: true },
  });
  const groupIdBySplitwiseId = new Map(
    existingGroups.map((group) => [Number(group.splitwiseGroupId), group.id]),
  );

  const groups: PlannedGroup[] = splitwiseGroups.map((group) => ({
    splitwiseId: group.id,
    name: group.name,
    memberSplitwiseIds: group.members.map((member) => member.id),
    existingId: groupIdBySplitwiseId.get(group.id),
    defaultCurrency: currencyOrSkip(group.default_currency),
  }));

  const existingExpenses = await db.expense.findMany({
    where: {
      transactionId: {
        in: splitwiseExpenses.map((expense) => `${IMPORT_PREFIX}${expense.id}`),
      },
    },
    select: { transactionId: true },
  });
  const existingTransactionIds = new Set(existingExpenses.map((expense) => expense.transactionId));
  const plannedExpenses: PlannedExpense[] = [];

  for (const expense of splitwiseExpenses) {
    const transactionId = `${IMPORT_PREFIX}${expense.id}`;
    if (existingTransactionIds.has(transactionId)) {
      continue;
    }
    if (expense.deleted_at || expense.deleted_by) {
      skips.push({ splitwiseExpenseId: expense.id, reason: 'deleted in Splitwise' });
      continue;
    }

    const currency = currencyOrSkip(expense.currency_code);
    if (!currency) {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason: `unsupported or missing currency ${expense.currency_code ?? '(missing)'}`,
      });
      continue;
    }

    const amount = decimalToMinor(expense.cost, currency);
    if (amount <= 0n) {
      skips.push({ splitwiseExpenseId: expense.id, reason: 'zero or negative total cost' });
      continue;
    }

    const totalPaid = expense.users.reduce(
      (sum, user) => sum + decimalToMinor(user.paid_share, currency),
      0n,
    );
    const totalOwed = expense.users.reduce(
      (sum, user) => sum + decimalToMinor(user.owed_share, currency),
      0n,
    );
    if (totalPaid !== amount || totalOwed !== amount) {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason: `paid/owed totals do not reconcile with cost: cost=${amount} paid=${totalPaid} owed=${totalOwed}`,
        payerDebug: buildPayerDebug(expense, currency),
      });
      continue;
    }

    const payer = findSinglePayer(expense, currency);
    if (!payer) {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason: 'multiple, missing, or unidentifiable payers',
        payerDebug: buildPayerDebug(expense, currency),
      });
      continue;
    }

    const payerUser = usersBySplitwiseId.get(payer.splitwiseUserId);
    if (!payerUser || payerUser.resolutionMethod === 'unresolved') {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason: `payer Splitwise user ${payer.splitwiseUserId} is unresolved; add ${USER_MAP_PATH} entry or pass --create-missing-users`,
        payerDebug: buildPayerDebug(expense, currency),
      });
      continue;
    }

    const participantCandidates = expense.users.map((user) => {
      const identity = expenseUserIdentity(user);
      return {
        splitwiseUserId: identity?.id,
        amount:
          decimalToMinor(user.paid_share, currency) - decimalToMinor(user.owed_share, currency),
      };
    });
    const unidentifiedParticipant = participantCandidates.find(
      (participant) => typeof participant.splitwiseUserId !== 'number',
    );
    if (unidentifiedParticipant) {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason:
          'participant user identity could not be derived from users[].user_id, users[].id, or users[].user.id',
        payerDebug: buildPayerDebug(expense, currency),
      });
      continue;
    }
    const participants = participantCandidates as { splitwiseUserId: number; amount: bigint }[];
    const unresolvedParticipant = participants.find((participant) => {
      const user = usersBySplitwiseId.get(participant.splitwiseUserId);
      return !user || user.resolutionMethod === 'unresolved';
    });
    if (unresolvedParticipant) {
      skips.push({
        splitwiseExpenseId: expense.id,
        reason: `participant Splitwise user ${unresolvedParticipant.splitwiseUserId} is unresolved; add ${USER_MAP_PATH} entry or pass --create-missing-users`,
      });
      continue;
    }

    if (expense.group_id) {
      const plannedGroup = groups.find((group) => group.splitwiseId === expense.group_id);
      if (!plannedGroup) {
        skips.push({
          splitwiseExpenseId: expense.id,
          reason: `Splitwise group ${expense.group_id} is not included in get_groups response`,
        });
        continue;
      }
    }

    plannedExpenses.push({
      splitwiseId: expense.id,
      transactionId,
      groupSplitwiseId: expense.group_id ?? undefined,
      paidBySplitwiseId: payer.splitwiseUserId,
      name:
        expense.description?.trim() ||
        (expense.payment ? 'Splitwise payment' : 'Splitwise expense'),
      amount,
      currency,
      category: expense.category?.name?.trim() || DEFAULT_CATEGORY,
      splitType: expense.payment ? SplitType.SETTLEMENT : SplitType.EXACT,
      expenseDate: new Date(expense.date ?? expense.created_at ?? Date.now()),
      participants: participants.filter((participant) => participant.amount !== 0n),
      note: buildNote(expense),
    });
  }

  return {
    currentSplitwiseUserId: currentUser.id,
    currentUserId: currentPlannedUser.splitProUserId,
    createMissingUsers,
    users,
    groups,
    expenses: plannedExpenses,
    skips,
    existingExpenseCount: existingExpenses.length,
  };
};

const formatTotals = (totalsByCurrency: Map<CurrencyCode, MoneyTotals>) =>
  [...totalsByCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, totals]) => {
      const divisor = 10n ** BigInt(CURRENCIES[currency].decimalDigits);
      return `${currency} paid=${totals.paid / divisor} owed=${totals.owed / divisor}`;
    })
    .join('; ') || 'none';

const printUserMapping = (plan: Plan) => {
  console.log('\nSplitwise users found:');
  for (const user of plan.users) {
    const resolution =
      user.resolutionMethod === 'mapping'
        ? `mapped to User.id ${user.splitProUserId}`
        : user.resolutionMethod === 'email'
          ? `matched by email to User.id ${user.splitProUserId}`
          : user.resolutionMethod === 'create'
            ? 'will create placeholder user'
            : 'unresolved';
    const note = user.mappingNote ? ` note=${user.mappingNote}` : '';

    console.log(
      [
        `- splitwiseId=${user.splitwiseId}`,
        `name="${user.name}"`,
        `email=${user.email ?? '(none)'}`,
        `groups=${user.groups.join(', ') || '(none)'}`,
        `totals=${formatTotals(user.totalsByCurrency)}`,
        `resolution=${resolution}${note}`,
      ].join(' | '),
    );
  }
};

const printPlanSummary = (plan: Plan) => {
  const usersToCreate = plan.users.filter((user) => user.resolutionMethod === 'create');
  const unresolvedUsers = plan.users.filter((user) => user.resolutionMethod === 'unresolved');
  const newGroups = plan.groups.filter((group) => !group.existingId);
  const byGroup = new Map<string, number>();
  const byUser = new Map<number, number>();

  for (const expense of plan.expenses) {
    byGroup.set(
      String(expense.groupSplitwiseId ?? 'non-group'),
      (byGroup.get(String(expense.groupSplitwiseId ?? 'non-group')) ?? 0) + 1,
    );
    byUser.set(expense.paidBySplitwiseId, (byUser.get(expense.paidBySplitwiseId) ?? 0) + 1);
  }

  printUserMapping(plan);
  console.log('\nImport plan');
  console.log(`- Users to create: ${usersToCreate.length}`);
  console.log(`- Unresolved users: ${unresolvedUsers.length}`);
  console.log(`- New groups: ${newGroups.length}`);
  console.log(`- New expenses: ${plan.expenses.length}`);
  console.log(`- Already imported expenses: ${plan.existingExpenseCount}`);
  console.log(`- Skipped expenses/items: ${plan.skips.length}`);

  console.log('\nExpenses by group:');
  for (const [group, count] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${group}: ${count}`);
  }

  console.log('\nExpenses by payer:');
  for (const [splitwiseUserId, count] of [...byUser.entries()].sort((a, b) => a[0] - b[0])) {
    const user = plan.users.find((candidate) => candidate.splitwiseId === splitwiseUserId);
    console.log(`- ${user?.name ?? splitwiseUserId}: ${count}`);
  }

  if (plan.skips.length > 0) {
    console.log('\nSkipped:');
    for (const skip of plan.skips) {
      console.log(
        `- ${skip.splitwiseExpenseId ? `expense ${skip.splitwiseExpenseId}: ` : ''}${skip.reason}`,
      );
      if (skip.payerDebug) {
        console.log(`  description: ${skip.payerDebug.description ?? '(none)'}`);
        console.log(
          `  cost: ${skip.payerDebug.cost} ${skip.payerDebug.currency ?? '(unknown)'} cost_minor=${skip.payerDebug.costMinor} total_paid_minor=${skip.payerDebug.totalPaidMinor} total_owed_minor=${skip.payerDebug.totalOwedMinor}`,
        );
        console.log('  raw users:');
        for (const user of skip.payerDebug.rawUsers) {
          console.log(
            `  - id=${user.id ?? '(none)'} user_id=${user.userId ?? '(none)'} nestedUserId=${user.nestedUserId ?? '(none)'} name="${user.name}" email=${user.email ?? '(none)'} paid_share=${user.paidShare} owed_share=${user.owedShare} net_balance=${user.netBalance ?? '(none)'}`,
          );
        }
        console.log('  computed payer candidates:');
        for (const candidate of skip.payerDebug.payerCandidates) {
          console.log(
            `  - splitwiseUserId=${candidate.splitwiseUserId ?? '(none)'} name="${candidate.name}" email=${candidate.email ?? '(none)'} paid_share=${candidate.paidShare} paid_share_minor=${candidate.paidShareMinor ?? '(parse failed)'} isPayer=${candidate.isPayer}`,
          );
        }
      }
    }
  }
};

const printFinalSummary = (plan: Plan, imported: number) => {
  const byGroup = new Map<string, number>();
  const byPayer = new Map<number, number>();

  for (const expense of plan.expenses) {
    const groupLabel = expense.groupSplitwiseId
      ? (plan.groups.find((group) => group.splitwiseId === expense.groupSplitwiseId)?.name ??
        String(expense.groupSplitwiseId))
      : 'Non-group expenses';

    byGroup.set(groupLabel, (byGroup.get(groupLabel) ?? 0) + 1);
    byPayer.set(expense.paidBySplitwiseId, (byPayer.get(expense.paidBySplitwiseId) ?? 0) + 1);
  }

  console.log('\nFinal import summary');
  console.log(`- Imported expenses: ${imported}`);
  console.log(`- Skipped expenses/items: ${plan.skips.length}`);
  console.log(`- Already imported before this run: ${plan.existingExpenseCount}`);

  console.log('\nImported by group:');
  for (const [group, count] of [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`- ${group}: ${count}`);
  }

  console.log('\nImported by payer:');
  for (const [splitwiseUserId, count] of [...byPayer.entries()].sort((a, b) => a[0] - b[0])) {
    const user = plan.users.find((candidate) => candidate.splitwiseId === splitwiseUserId);
    console.log(`- ${user?.name ?? splitwiseUserId}: ${count}`);
  }
};

const createPlaceholderUser = async (user: PlannedUser) =>
  db.user.create({
    data: {
      email: user.email,
      name: user.name,
    },
    select: { id: true },
  });

const commitPlan = async (plan: Plan) => {
  const splitwiseUserIdToDbUserId = new Map<number, number>();

  for (const user of plan.users) {
    if (user.splitProUserId) {
      splitwiseUserIdToDbUserId.set(user.splitwiseId, user.splitProUserId);
      continue;
    }

    if (user.resolutionMethod !== 'create') {
      continue;
    }

    const dbUser = await createPlaceholderUser(user);
    splitwiseUserIdToDbUserId.set(user.splitwiseId, dbUser.id);
  }

  const currentUserId = splitwiseUserIdToDbUserId.get(plan.currentSplitwiseUserId);
  if (!currentUserId) {
    throw new Error(
      `Current Splitwise user ${plan.currentSplitwiseUserId} is unresolved. Add ${USER_MAP_PATH} entry or pass --create-missing-users.`,
    );
  }

  const splitwiseGroupIdToDbGroupId = new Map<number, number>();
  for (const group of plan.groups) {
    const memberUserIds = group.memberSplitwiseIds
      .map((splitwiseUserId) => splitwiseUserIdToDbUserId.get(splitwiseUserId))
      .filter((userId): userId is number => Boolean(userId));

    const dbGroup = group.existingId
      ? { id: group.existingId }
      : await db.group.create({
          data: {
            name: group.name,
            publicId: nanoid(),
            userId: currentUserId,
            defaultCurrency: group.defaultCurrency,
            splitwiseGroupId: String(group.splitwiseId),
            groupUsers: {
              create: memberUserIds.map((userId) => ({ userId })),
            },
          },
          select: { id: true },
        });
    splitwiseGroupIdToDbGroupId.set(group.splitwiseId, dbGroup.id);

    await db.groupUser.createMany({
      data: memberUserIds.map((userId) => ({ groupId: dbGroup.id, userId })),
      skipDuplicates: true,
    });
  }

  let imported = 0;
  for (const expense of plan.expenses) {
    const paidByUserId = splitwiseUserIdToDbUserId.get(expense.paidBySplitwiseId);
    if (!paidByUserId) {
      throw new Error(`Missing payer mapping for Splitwise expense ${expense.splitwiseId}`);
    }

    const groupId = expense.groupSplitwiseId
      ? splitwiseGroupIdToDbGroupId.get(expense.groupSplitwiseId)
      : null;

    const participantData = expense.participants.map((participant) => {
      const userId = splitwiseUserIdToDbUserId.get(participant.splitwiseUserId);
      if (!userId) {
        throw new Error(
          `Missing participant mapping for Splitwise user ${participant.splitwiseUserId}`,
        );
      }
      return { userId, amount: participant.amount };
    });

    await db.$transaction(async (tx) => {
      const existing = await tx.expense.findFirst({
        where: { transactionId: expense.transactionId },
        select: { id: true },
      });
      if (existing) {
        return;
      }

      const createdExpense = await tx.expense.create({
        data: {
          paidBy: paidByUserId,
          addedBy: currentUserId,
          name: expense.name,
          category: expense.category,
          amount: expense.amount,
          splitType: expense.splitType,
          expenseDate: expense.expenseDate,
          createdAt: expense.expenseDate,
          updatedAt: expense.expenseDate,
          currency: expense.currency,
          groupId,
          transactionId: expense.transactionId,
          expenseParticipants: { create: participantData },
        },
        select: { id: true },
      });

      await tx.expenseNote.create({
        data: {
          expenseId: createdExpense.id,
          createdById: currentUserId,
          note: expense.note,
        },
      });
    });
    imported += 1;
  }

  return imported;
};

const deleteImported = async (yes: boolean) => {
  const count = await db.expense.count({
    where: { transactionId: { startsWith: IMPORT_PREFIX } },
  });
  console.log(`Found ${count} imported Splitwise expenses to delete.`);

  if (!yes) {
    throw new Error(
      'Rollback requires --yes, for example: pnpm import:splitwise --delete-imported --yes',
    );
  }

  const result = await db.expense.deleteMany({
    where: { transactionId: { startsWith: IMPORT_PREFIX } },
  });

  console.log(`Deleted ${result.count} imported Splitwise expenses.`);
};

const listSplitProUsers = async () => {
  const users = await db.user.findMany({
    orderBy: [{ id: 'asc' }],
    select: {
      id: true,
      name: true,
      email: true,
    },
  });

  console.log('Split Pro users:');
  for (const user of users) {
    console.log(
      `- id=${user.id} name="${user.name ?? '(no name)'}" email=${user.email ?? '(no email)'}`,
    );
  }
};

const main = async () => {
  ensureDatabaseUrl();
  const args = parseArgs();

  if (args.mode === 'list-splitpro-users') {
    await listSplitProUsers();
    return;
  }

  if (args.mode === 'delete-imported') {
    await deleteImported(args.yes);
    return;
  }

  const token = getToken();
  const { currentUser, groups, expenses } = await fetchSplitwiseData(token);
  const plan = await buildPlan(currentUser, groups, expenses, args.createMissingUsers);
  printPlanSummary(plan);

  if (args.mode === 'dry-run') {
    console.log('\nDry run only. No database writes were made.');
    return;
  }

  console.log('\nWARNING: commit mode writes directly to the Split Pro database.');
  console.log('Back up your database before continuing and verify the dry-run counts first.');
  console.log(
    'Rollback deletes imported expenses with transactionId starting with "splitwise:", but it does not remove created groups or users.',
  );

  const imported = await commitPlan(plan);
  printFinalSummary(plan, imported);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
