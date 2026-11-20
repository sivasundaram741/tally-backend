import { find, findOne, count, aggregate, namesById } from '../db/index.js';
import { money } from '../lib/http.js';
import { financialYearEnd } from './companies.js';

/** Vouchers that count towards the books: not deleted, cancelled or optional. */
const posted = (companyId) => ({ company_id: companyId, is_deleted: 0, is_cancelled: 0, is_optional: 0 });

/** Ledger movement summed per ledger and side, for vouchers matching `match`. */
async function entryTotals(match) {
  const rows = await aggregate('vouchers', [
    { $match: match },
    { $unwind: '$entries' },
    {
      $group: {
        _id: { ledger_id: '$entries.ledger_id', dr_cr: '$entries.dr_cr' },
        amt: { $sum: '$entries.amount' },
      },
    },
  ]);
  return rows.map((r) => ({ ledger_id: r._id.ledger_id, dr_cr: r._id.dr_cr, amt: r.amt }));
}

/** Stock movement summed per item and direction, for vouchers matching `match`. */
async function inventoryTotals(match) {
  const rows = await aggregate('vouchers', [
    { $match: match },
    { $unwind: '$inventory' },
    {
      $group: {
        _id: { stock_item_id: '$inventory.stock_item_id', direction: '$inventory.direction' },
        qty: { $sum: '$inventory.quantity' },
        amt: { $sum: '$inventory.amount' },
      },
    },
  ]);
  return rows.map((r) => ({
    stock_item_id: r._id.stock_item_id, direction: r._id.direction, qty: r.qty, amt: r.amt,
  }));
}

/** Resolves the reporting period, defaulting to the company financial year. */
export async function period(companyId, q = {}) {
  const c = await findOne('companies', { id: companyId }, {
    project: { financial_year_from: 1, books_begin_from: 1 },
  });
  const fyFrom = c?.financial_year_from || `${new Date().getFullYear()}-04-01`;
  return {
    from: q.from || c?.books_begin_from || fyFrom,
    to: q.to || financialYearEnd(fyFrom),
    fyFrom,
    fyTo: financialYearEnd(fyFrom),
  };
}

const SIGN = (drCr) => (drCr === 'Dr' ? 1 : -1);

/**
 * Per-ledger opening / debit / credit / closing for a period.
 * Signed amounts are debit-positive.
 */
export async function ledgerBalances(companyId, { from, to } = {}) {
  const [ledgerRows, groups, movements, priors] = await Promise.all([
    find('ledgers', { company_id: companyId }, { sort: { name: 1 } }),
    find('groups', { company_id: companyId }, { project: { id: 1, name: 1, nature: 1 } }),
    entryTotals({ ...posted(companyId), date: { $gte: from, $lte: to } }),
    entryTotals({ ...posted(companyId), date: { $lt: from } }),
  ]);
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const ledgers = ledgerRows
    .filter((l) => groupById.has(l.group_id))
    .map((l) => ({ ...l, group_name: groupById.get(l.group_id).name, nature: groupById.get(l.group_id).nature }));

  const mv = new Map();
  for (const m of movements) {
    const cur = mv.get(m.ledger_id) || { dr: 0, cr: 0 };
    if (m.dr_cr === 'Dr') cur.dr += m.amt;
    else cur.cr += m.amt;
    mv.set(m.ledger_id, cur);
  }
  const pr = new Map();
  for (const p of priors) {
    const cur = pr.get(p.ledger_id) || 0;
    pr.set(p.ledger_id, cur + SIGN(p.dr_cr) * p.amt);
  }

  return ledgers.map((l) => {
    const m = mv.get(l.id) || { dr: 0, cr: 0 };
    const openingBase = SIGN(l.opening_balance_type) * (l.opening_balance || 0);
    const opening = money(openingBase + (pr.get(l.id) || 0));
    const debit = money(m.dr);
    const credit = money(m.cr);
    const closing = money(opening + debit - credit);
    return {
      id: l.id,
      name: l.name,
      group_id: l.group_id,
      group_name: l.group_name,
      nature: l.nature,
      opening,
      debit,
      credit,
      closing,
    };
  });
}

function groupRows(companyId) {
  return find('groups', { company_id: companyId }, { sort: { sort_position: 1, name: 1 } });
}

/**
 * Builds the group hierarchy with ledger balances rolled up into each node.
 */
export async function groupTree(companyId, { from, to } = {}, opts = {}) {
  const groups = await groupRows(companyId);
  const balances = await ledgerBalances(companyId, { from, to });
  const byId = new Map();
  for (const g of groups) {
    byId.set(g.id, {
      id: g.id,
      name: g.name,
      nature: g.nature,
      is_primary: !!g.is_primary,
      affects_gross_profit: !!g.affects_gross_profit,
      parent_id: g.parent_id,
      type: 'group',
      children: [],
      ledgers: [],
      opening: 0,
      debit: 0,
      credit: 0,
      closing: 0,
    });
  }
  for (const g of groups) {
    const node = byId.get(g.id);
    if (g.parent_id && byId.has(g.parent_id)) byId.get(g.parent_id).children.push(node);
  }
  for (const b of balances) {
    if (opts.skipLedgerIds?.has(b.id)) continue;
    const node = byId.get(b.group_id);
    if (!node) continue;
    node.ledgers.push({ ...b, type: 'ledger' });
  }

  const roll = (node) => {
    let o = 0;
    let d = 0;
    let c = 0;
    let cl = 0;
    for (const l of node.ledgers) {
      o += l.opening; d += l.debit; c += l.credit; cl += l.closing;
    }
    for (const ch of node.children) {
      roll(ch);
      o += ch.opening; d += ch.debit; c += ch.credit; cl += ch.closing;
    }
    node.opening = money(o);
    node.debit = money(d);
    node.credit = money(c);
    node.closing = money(cl);
  };

  const roots = groups.filter((g) => !g.parent_id).map((g) => byId.get(g.id));
  roots.forEach(roll);
  return { roots, byId, balances };
}

function sumNature(roots, natures) {
  return money(
    roots.filter((r) => natures.includes(r.nature)).reduce((s, r) => s + r.closing, 0),
  );
}

/** Closing stock value from inventory movement plus opening stock. */
export async function closingStockValue(companyId, { from, to } = {}) {
  const items = await find('stock_items', { company_id: companyId }, {
    project: { id: 1, opening_qty: 1, opening_rate: 1, opening_value: 1 },
  });
  const moves = await inventoryTotals({ ...posted(companyId), date: { $lte: to } });
  const map = new Map();
  for (const m of moves) {
    const cur = map.get(m.stock_item_id) || { inQty: 0, inAmt: 0, outQty: 0, outAmt: 0 };
    if (m.direction === 'In') { cur.inQty += m.qty; cur.inAmt += m.amt; }
    else { cur.outQty += m.qty; cur.outAmt += m.amt; }
    map.set(m.stock_item_id, cur);
  }
  let value = 0;
  for (const it of items) {
    const m = map.get(it.id) || { inQty: 0, inAmt: 0, outQty: 0, outAmt: 0 };
    const openValue = it.opening_value || it.opening_qty * it.opening_rate;
    const qty = it.opening_qty + m.inQty - m.outQty;
    const totalInQty = it.opening_qty + m.inQty;
    const totalInValue = openValue + m.inAmt;
    const avgRate = totalInQty ? totalInValue / totalInQty : it.opening_rate;
    value += qty * avgRate;
  }
  return money(value);
}

export async function openingStockValue(companyId) {
  const items = await find('stock_items', { company_id: companyId }, {
    project: { opening_qty: 1, opening_rate: 1, opening_value: 1 },
  });
  return money(items.reduce((s, i) => s + (i.opening_value || i.opening_qty * i.opening_rate), 0));
}

/** Trial Balance - group-wise debit/credit with ledger detail. */
export async function trialBalance(companyId, q = {}) {
  const p = await period(companyId, q);
  const { roots } = await groupTree(companyId, p);
  const rows = roots
    .filter((r) => r.closing !== 0 || r.ledgers.length || r.children.length)
    .map(shapeNode);
  const totals = rows.reduce(
    (acc, r) => {
      if (r.closing >= 0) acc.debit += r.closing;
      else acc.credit += -r.closing;
      acc.periodDebit += r.debit;
      acc.periodCredit += r.credit;
      return acc;
    },
    { debit: 0, credit: 0, periodDebit: 0, periodCredit: 0 },
  );
  return {
    period: p,
    rows,
    totals: {
      debit: money(totals.debit),
      credit: money(totals.credit),
      periodDebit: money(totals.periodDebit),
      periodCredit: money(totals.periodCredit),
    },
  };
}

function shapeNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    nature: node.nature,
    opening: node.opening,
    debit: node.debit,
    credit: node.credit,
    closing: node.closing,
    children: [
      ...node.children.filter((c) => c.closing !== 0 || c.ledgers.length || c.children.length).map(shapeNode),
      ...node.ledgers.map((l) => ({
        id: l.id,
        name: l.name,
        type: 'ledger',
        nature: l.nature,
        opening: l.opening,
        debit: l.debit,
        credit: l.credit,
        closing: l.closing,
        children: [],
      })),
    ],
  };
}

/** Profit & Loss A/c in the classic two-column layout. */
export async function profitAndLoss(companyId, q = {}) {
  const p = await period(companyId, q);
  const { roots } = await groupTree(companyId, p);

  const pick = (names) => roots.filter((r) => names.includes(r.name)).map(shapeNode);
  const total = (nodes) => money(nodes.reduce((s, n) => s + n.closing, 0));

  const purchases = pick(['Purchase Accounts']);
  const directExp = pick(['Direct Expenses']);
  const sales = pick(['Sales Accounts']);
  const directInc = pick(['Direct Incomes']);
  const indirectExp = pick(['Indirect Expenses']);
  const indirectInc = pick(['Indirect Incomes']);

  const openingStock = await openingStockValue(companyId);
  const closingStock = await closingStockValue(companyId, p);

  const purchaseTotal = total(purchases);
  const directExpTotal = total(directExp);
  const salesTotal = -total(sales);
  const directIncTotal = -total(directInc);
  const indirectExpTotal = total(indirectExp);
  const indirectIncTotal = -total(indirectInc);

  const grossProfit = money(
    salesTotal + directIncTotal + closingStock - openingStock - purchaseTotal - directExpTotal,
  );
  const netProfit = money(grossProfit + indirectIncTotal - indirectExpTotal);

  return {
    period: p,
    trading: {
      debitSide: [
        { name: 'Opening Stock', amount: openingStock, type: 'computed' },
        ...purchases.map((g) => ({ name: g.name, amount: g.closing, type: 'group', node: g })),
        ...directExp.map((g) => ({ name: g.name, amount: g.closing, type: 'group', node: g })),
      ],
      creditSide: [
        ...sales.map((g) => ({ name: g.name, amount: -g.closing, type: 'group', node: g })),
        ...directInc.map((g) => ({ name: g.name, amount: -g.closing, type: 'group', node: g })),
        { name: 'Closing Stock', amount: closingStock, type: 'computed' },
      ],
      grossProfit,
    },
    profitLoss: {
      debitSide: indirectExp.map((g) => ({ name: g.name, amount: g.closing, type: 'group', node: g })),
      creditSide: indirectInc.map((g) => ({ name: g.name, amount: -g.closing, type: 'group', node: g })),
      netProfit,
    },
    summary: {
      sales: salesTotal,
      purchases: purchaseTotal,
      directExpenses: directExpTotal,
      directIncomes: directIncTotal,
      indirectExpenses: indirectExpTotal,
      indirectIncomes: indirectIncTotal,
      openingStock,
      closingStock,
      grossProfit,
      netProfit,
    },
  };
}

/** Balance Sheet with the Profit & Loss A/c carried into Liabilities. */
export async function balanceSheet(companyId, q = {}) {
  const p = await period(companyId, q);
  const pl = await findOne('ledgers', { company_id: companyId, name: 'Profit & Loss A/c' }, { project: { id: 1 } });
  const skip = new Set(pl ? [pl.id] : []);
  const { roots } = await groupTree(companyId, p, { skipLedgerIds: skip });

  const liabilities = roots
    .filter((r) => r.nature === 'Liabilities')
    .map(shapeNode)
    .map((n) => ({ ...n, amount: money(-n.closing) }));
  const assets = roots
    .filter((r) => r.nature === 'Assets')
    .map(shapeNode)
    .map((n) => ({ ...n, amount: money(n.closing) }));

  const plReport = await profitAndLoss(companyId, q);
  const plRow = pl
    ? await findOne('ledgers', { id: pl.id }, { project: { opening_balance: 1, opening_balance_type: 1 } })
    : null;
  const plOpening = plRow ? money(SIGN(plRow.opening_balance_type) * plRow.opening_balance) : 0;
  const closingStock = plReport.summary.closingStock;

  const liabilityTotal = money(
    liabilities.reduce((s, n) => s + n.amount, 0) + plReport.summary.netProfit + -plOpening,
  );
  const assetTotal = money(assets.reduce((s, n) => s + n.amount, 0) + closingStock);

  return {
    period: p,
    liabilities: [
      ...liabilities,
      {
        id: -1,
        name: 'Profit & Loss A/c',
        type: 'computed',
        amount: money(plReport.summary.netProfit + -plOpening),
        children: [
          { id: -2, name: 'Opening Balance', type: 'computed', amount: money(-plOpening), children: [] },
          { id: -3, name: 'Current Period', type: 'computed', amount: plReport.summary.netProfit, children: [] },
        ],
      },
    ],
    assets: [
      ...assets,
      ...(closingStock
        ? [{ id: -4, name: 'Closing Stock', type: 'computed', amount: closingStock, children: [] }]
        : []),
    ],
    totals: {
      liabilities: liabilityTotal,
      assets: assetTotal,
      difference: money(liabilityTotal - assetTotal),
    },
  };
}

/** Ledger vouchers (account statement) for one ledger. */
export async function ledgerStatement(companyId, ledgerId, q = {}) {
  const p = await period(companyId, q);
  const ledgerRow = await findOne('ledgers', { id: ledgerId, company_id: companyId });
  const group = ledgerRow && await findOne('groups', { id: ledgerRow.group_id }, { project: { name: 1 } });
  if (!ledgerRow || !group) return null;
  const ledger = { ...ledgerRow, group_name: group.name };

  const balances = await ledgerBalances(companyId, p);
  const bal = balances.find((b) => b.id === Number(ledgerId));

  // each voucher touching this ledger carries its own lines, so the contra
  // entries come along without a second query
  const vouchers = await find('vouchers', {
    company_id: companyId,
    is_deleted: 0,
    date: { $gte: p.from, $lte: p.to },
    'entries.ledger_id': ledgerId,
  }, {
    sort: { date: 1, id: 1 },
    project: { id: 1, date: 1, voucher_number: 1, narration: 1, is_cancelled: 1, voucher_type_id: 1, entries: 1 },
  });
  const [typeNames, ledgerNames] = await Promise.all([
    namesById('voucher_types', vouchers.map((v) => v.voucher_type_id)),
    namesById('ledgers', vouchers.flatMap((v) => v.entries.map((e) => e.ledger_id))),
  ]);

  const rows = [];
  const contraByVoucher = new Map();
  for (const v of vouchers) {
    if (!typeNames.has(v.voucher_type_id)) continue;
    const lines = [...v.entries].sort((a, b) => (a.line_no - b.line_no) || (a.id - b.id));
    for (const e of lines) {
      if (e.ledger_id !== ledgerId) continue;
      rows.push({
        id: v.id,
        date: v.date,
        voucher_number: v.voucher_number,
        narration: v.narration,
        is_cancelled: v.is_cancelled,
        voucher_type_name: typeNames.get(v.voucher_type_id),
        dr_cr: e.dr_cr,
        amount: e.amount,
        entry_id: e.id,
      });
    }
    contraByVoucher.set(v.id, [...v.entries]
      .sort((a, b) => a.id - b.id)
      .filter((e) => e.ledger_id !== ledgerId && ledgerNames.has(e.ledger_id))
      .map((e) => ({ voucher_id: v.id, name: ledgerNames.get(e.ledger_id), dr_cr: e.dr_cr, amount: e.amount })));
  }

  let running = bal ? bal.opening : 0;
  const lines = rows.map((row) => {
    const contra = contraByVoucher.get(row.id) || [];
    if (!row.is_cancelled) running = money(running + SIGN(row.dr_cr) * row.amount);
    return {
      ...row,
      particulars: contra.length === 1 ? contra[0].name : contra.length ? '(as per details)' : '',
      contra,
      debit: row.dr_cr === 'Dr' ? money(row.amount) : 0,
      credit: row.dr_cr === 'Cr' ? money(row.amount) : 0,
      running: money(running),
    };
  });

  return {
    period: p,
    ledger: { id: ledger.id, name: ledger.name, group_name: ledger.group_name },
    opening: bal ? bal.opening : 0,
    closing: bal ? bal.closing : 0,
    totals: {
      debit: money(lines.reduce((s, l) => s + l.debit, 0)),
      credit: money(lines.reduce((s, l) => s + l.credit, 0)),
    },
    lines,
  };
}

/** Stock Summary - quantity and value movement per item. */
export async function stockSummary(companyId, q = {}) {
  const p = await period(companyId, q);
  const itemRows = await find('stock_items', { company_id: companyId }, { sort: { name: 1 } });
  const [groupNames, unitNames, inPeriod, before] = await Promise.all([
    namesById('stock_groups', itemRows.map((it) => it.stock_group_id)),
    namesById('units', itemRows.map((it) => it.unit_id), 'symbol'),
    inventoryTotals({ ...posted(companyId), date: { $gte: p.from, $lte: p.to } }),
    inventoryTotals({ ...posted(companyId), date: { $lt: p.from } }),
  ]);
  const items = itemRows.map((it) => ({
    ...it,
    stock_group_name: groupNames.get(it.stock_group_id) ?? null,
    unit_name: unitNames.get(it.unit_id) ?? null,
  }));

  const agg = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const cur = m.get(r.stock_item_id) || { inQty: 0, inAmt: 0, outQty: 0, outAmt: 0 };
      if (r.direction === 'In') { cur.inQty += r.qty; cur.inAmt += r.amt; }
      else { cur.outQty += r.qty; cur.outAmt += r.amt; }
      m.set(r.stock_item_id, cur);
    }
    return m;
  };
  const pre = agg(before);
  const cur = agg(inPeriod);

  const rows = items.map((it) => {
    const b = pre.get(it.id) || { inQty: 0, inAmt: 0, outQty: 0, outAmt: 0 };
    const c = cur.get(it.id) || { inQty: 0, inAmt: 0, outQty: 0, outAmt: 0 };
    const openValueBase = it.opening_value || it.opening_qty * it.opening_rate;
    // Stock is valued at average cost, so only inward movement feeds the rate.
    const costQty = it.opening_qty + b.inQty + c.inQty;
    const costValue = openValueBase + b.inAmt + c.inAmt;
    const avgRate = costQty ? costValue / costQty : it.opening_rate;
    const openQty = it.opening_qty + b.inQty - b.outQty;
    const openValue = money(openQty * avgRate);
    const closeQty = openQty + c.inQty - c.outQty;
    const closeValue = money(closeQty * avgRate);
    return {
      id: it.id,
      name: it.name,
      stock_group_name: it.stock_group_name || '',
      unit_name: it.unit_name || '',
      openingQty: openQty,
      openingValue: openValue,
      inwardQty: c.inQty,
      inwardValue: money(c.inAmt),
      outwardQty: c.outQty,
      outwardValue: money(c.outAmt),
      closingQty: closeQty,
      closingValue: closeValue,
      closingRate: closeQty ? money(closeValue / closeQty) : 0,
    };
  });

  return {
    period: p,
    rows,
    totals: {
      openingValue: money(rows.reduce((s, r) => s + r.openingValue, 0)),
      inwardValue: money(rows.reduce((s, r) => s + r.inwardValue, 0)),
      outwardValue: money(rows.reduce((s, r) => s + r.outwardValue, 0)),
      closingValue: money(rows.reduce((s, r) => s + r.closingValue, 0)),
    },
  };
}

/** Bills outstanding for receivables (Sundry Debtors) or payables (Creditors). */
export async function outstandings(companyId, kind = 'receivable', q = {}) {
  const p = await period(companyId, q);
  const groupName = kind === 'payable' ? 'Sundry Creditors' : 'Sundry Debtors';
  // ledgers sitting directly under the group, in name order
  const groups = await find('groups', { company_id: companyId, name: groupName }, { project: { id: 1 } });
  const ledgers = await find('ledgers', {
    company_id: companyId, group_id: { $in: groups.map((g) => g.id) },
  }, { sort: { name: 1 }, project: { id: 1, name: 1 } });
  const ledgerRank = new Map(ledgers.map((l, i) => [l.id, i]));
  const ledgerName = new Map(ledgers.map((l) => [l.id, l.name]));

  const vouchers = await find('vouchers', {
    company_id: companyId,
    is_deleted: 0,
    is_cancelled: 0,
    date: { $lte: p.to },
    'bills.ledger_id': { $in: ledgers.map((l) => l.id) },
  }, { project: { id: 1, date: 1, voucher_type_id: 1, bills: 1 } });
  const typeNames = await namesById('voucher_types', vouchers.map((v) => v.voucher_type_id));

  const rows = vouchers
    .filter((v) => typeNames.has(v.voucher_type_id))
    .flatMap((v) => v.bills
      .filter((b) => ledgerRank.has(b.ledger_id))
      .map((b) => ({
        ...b,
        voucher_id: v.id,
        ledger_name: ledgerName.get(b.ledger_id),
        date: v.date,
        voucher_type_name: typeNames.get(v.voucher_type_id),
        group_name: groupName,
      })))
    .sort((a, b) => (ledgerRank.get(a.ledger_id) - ledgerRank.get(b.ledger_id))
      || a.date.localeCompare(b.date) || (a.voucher_id - b.voucher_id) || (a.id - b.id));

  const byBill = new Map();
  for (const r of rows) {
    const key = `${r.ledger_id}::${r.bill_name || `#${r.voucher_id}`}`;
    const cur = byBill.get(key) || {
      ledger_id: r.ledger_id,
      ledger_name: r.ledger_name,
      bill_name: r.bill_name || `#${r.voucher_id}`,
      date: r.date,
      due_date: r.due_date,
      voucher_type_name: r.voucher_type_name,
      pending: 0,
    };
    cur.pending = money(cur.pending + SIGN(r.dr_cr) * r.amount);
    if (r.due_date) cur.due_date = r.due_date;
    byBill.set(key, cur);
  }

  const bills = [...byBill.values()]
    .filter((b) => Math.abs(b.pending) > 0.009)
    .map((b) => ({
      ...b,
      pending: kind === 'payable' ? money(-b.pending) : b.pending,
      overdueDays: b.due_date ? daysBetween(b.due_date, p.to) : 0,
    }));

  return {
    period: p,
    kind,
    bills,
    total: money(bills.reduce((s, b) => s + b.pending, 0)),
  };
}

function daysBetween(a, b) {
  const d = (new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000;
  return Math.max(0, Math.round(d));
}

/** Group summary - monthly movement for one group. */
export async function groupSummary(companyId, groupId, q = {}) {
  const p = await period(companyId, q);
  const { byId } = await groupTree(companyId, p);
  const node = byId.get(Number(groupId));
  if (!node) return null;
  return { period: p, group: shapeNode(node) };
}

/** Ratio analysis: the key numbers on one screen. */
export async function ratioAnalysis(companyId, q = {}) {
  const p = await period(companyId, q);
  const bs = await balanceSheet(companyId, q);
  const pl = await profitAndLoss(companyId, q);
  const balances = await ledgerBalances(companyId, p);

  const sumGroup = (name) => money(
    balances.filter((b) => b.group_name === name).reduce((s, b) => s + b.closing, 0),
  );

  const debtors = sumGroup('Sundry Debtors');
  const creditors = money(-sumGroup('Sundry Creditors'));
  const cash = money(sumGroup('Cash-in-Hand') + sumGroup('Bank Accounts'));
  const stock = pl.summary.closingStock;
  const currentAssets = money(
    (bs.assets.find((a) => a.name === 'Current Assets')?.amount || 0) + stock,
  );
  const currentLiabilities = bs.liabilities.find((l) => l.name === 'Current Liabilities')?.amount || 0;
  const workingCapital = money(currentAssets - currentLiabilities);

  return {
    period: p,
    principal: [
      { name: 'Working Capital', value: workingCapital, note: 'Current Assets - Current Liabilities' },
      { name: 'Cash-in-Hand & Bank', value: cash },
      { name: 'Sundry Debtors (Receivables)', value: debtors },
      { name: 'Sundry Creditors (Payables)', value: creditors },
      { name: 'Closing Stock', value: stock },
      { name: 'Net Profit', value: pl.summary.netProfit },
    ],
    ratios: [
      {
        name: 'Current Ratio',
        value: currentLiabilities ? round2(currentAssets / currentLiabilities) : 0,
        note: 'Current Assets : Current Liabilities',
      },
      {
        name: 'Quick Ratio',
        value: currentLiabilities ? round2((currentAssets - stock) / currentLiabilities) : 0,
        note: 'Liquid Assets : Current Liabilities',
      },
      {
        name: 'Debt/Equity Ratio',
        value: (() => {
          const capital = bs.liabilities.find((l) => l.name === 'Capital Account')?.amount || 0;
          const loans = bs.liabilities.find((l) => l.name === 'Loans (Liability)')?.amount || 0;
          return capital ? round2(loans / capital) : 0;
        })(),
      },
      {
        name: 'Gross Profit %',
        value: pl.summary.sales ? round2((pl.summary.grossProfit / pl.summary.sales) * 100) : 0,
      },
      {
        name: 'Net Profit %',
        value: pl.summary.sales ? round2((pl.summary.netProfit / pl.summary.sales) * 100) : 0,
      },
      {
        name: 'Inventory Turnover',
        value: stock ? round2(pl.summary.sales / stock) : 0,
      },
    ],
  };
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** Cash / Bank book: ledgers under Cash-in-Hand and Bank Accounts. */
export async function cashBankBooks(companyId, q = {}) {
  const p = await period(companyId, q);
  const balances = await ledgerBalances(companyId, p);
  return {
    period: p,
    rows: balances.filter((b) => ['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c'].includes(b.group_name)),
  };
}

/** Day book totals used by the Gateway "current period" strip. */
export async function dashboard(companyId, q = {}) {
  const p = await period(companyId, q);
  const pl = await profitAndLoss(companyId, q);
  const bs = await balanceSheet(companyId, q);
  const [vouchers, deleted, cancelled, editTotal, altered] = await Promise.all([
    count('vouchers', { company_id: companyId }),
    count('vouchers', { company_id: companyId, is_deleted: 1 }),
    count('vouchers', { company_id: companyId, is_cancelled: 1 }),
    count('edit_log', { company_id: companyId }),
    count('edit_log', { company_id: companyId, action: 'Altered' }),
  ]);
  return {
    period: p,
    vouchers,
    deletedVouchers: deleted,
    cancelledVouchers: cancelled,
    editLogEntries: editTotal,
    alteredEntries: altered,
    sales: pl.summary.sales,
    purchases: pl.summary.purchases,
    netProfit: pl.summary.netProfit,
    closingStock: pl.summary.closingStock,
    balanceSheetTotal: bs.totals.assets,
    difference: bs.totals.difference,
  };
}
