import { all, get } from '../db/index.js';
import { money, toNum } from '../lib/http.js';
import { financialYearEnd } from './companies.js';

/** Resolves the reporting period, defaulting to the company financial year. */
export async function period(companyId, q = {}) {
  const c = await get('SELECT financial_year_from, books_begin_from FROM companies WHERE id = ?', [companyId]);
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
  const ledgers = await all(
    `SELECT l.*, g.name AS group_name, g.nature, g.id AS gid
       FROM ledgers l JOIN groups g ON g.id = l.group_id
      WHERE l.company_id = ? ORDER BY l.name COLLATE NOCASE`,
    [companyId],
  );

  const movements = await all(
    `SELECT e.ledger_id, e.dr_cr, SUM(e.amount) AS amt
       FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0
        AND v.is_optional = 0 AND v.date >= ? AND v.date <= ?
      GROUP BY e.ledger_id, e.dr_cr`,
    [companyId, from, to],
  );

  const priors = await all(
    `SELECT e.ledger_id, e.dr_cr, SUM(e.amount) AS amt
       FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0
        AND v.is_optional = 0 AND v.date < ?
      GROUP BY e.ledger_id, e.dr_cr`,
    [companyId, from],
  );

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
  return all(
    `SELECT * FROM groups WHERE company_id = ? ORDER BY sort_position, name COLLATE NOCASE`,
    [companyId],
  );
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
  const items = await all('SELECT id, opening_qty, opening_rate, opening_value FROM stock_items WHERE company_id = ?', [companyId]);
  const moves = await all(
    `SELECT i.stock_item_id, i.direction, SUM(i.quantity) AS qty, SUM(i.amount) AS amt
       FROM voucher_inventory i JOIN vouchers v ON v.id = i.voucher_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0 AND v.is_optional = 0
        AND v.date <= ?
      GROUP BY i.stock_item_id, i.direction`,
    [companyId, to],
  );
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
  const items = await all('SELECT opening_qty, opening_rate, opening_value FROM stock_items WHERE company_id = ?', [companyId]);
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
  const pl = await get("SELECT id FROM ledgers WHERE company_id = ? AND name = 'Profit & Loss A/c'", [companyId]);
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
    ? await get('SELECT opening_balance, opening_balance_type FROM ledgers WHERE id = ?', [pl.id])
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
  const ledger = await get(
    `SELECT l.*, g.name AS group_name FROM ledgers l JOIN groups g ON g.id = l.group_id
      WHERE l.id = ? AND l.company_id = ?`,
    [ledgerId, companyId],
  );
  if (!ledger) return null;

  const balances = await ledgerBalances(companyId, p);
  const bal = balances.find((b) => b.id === Number(ledgerId));
  const rows = await all(
    `SELECT v.id, v.date, v.voucher_number, v.narration, v.is_cancelled,
            vt.name AS voucher_type_name, e.dr_cr, e.amount, e.id AS entry_id
       FROM voucher_entries e
       JOIN vouchers v ON v.id = e.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
      WHERE v.company_id = ? AND e.ledger_id = ? AND v.is_deleted = 0
        AND v.date >= ? AND v.date <= ?
      ORDER BY v.date, v.id`,
    [companyId, ledgerId, p.from, p.to],
  );

  // every contra entry in one query rather than one query per line
  const voucherIds = [...new Set(rows.map((r) => r.id))];
  const contraRows = voucherIds.length
    ? await all(
      `SELECT e.voucher_id, l.name, e.dr_cr, e.amount FROM voucher_entries e
         JOIN ledgers l ON l.id = e.ledger_id
        WHERE e.voucher_id IN (${voucherIds.map(() => '?').join(',')}) AND e.ledger_id <> ?`,
      [...voucherIds, ledgerId],
    )
    : [];
  const contraByVoucher = new Map();
  for (const c of contraRows) {
    if (!contraByVoucher.has(c.voucher_id)) contraByVoucher.set(c.voucher_id, []);
    contraByVoucher.get(c.voucher_id).push(c);
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
  const items = await all(
    `SELECT s.*, g.name AS stock_group_name, u.symbol AS unit_name
       FROM stock_items s
       LEFT JOIN stock_groups g ON g.id = s.stock_group_id
       LEFT JOIN units u ON u.id = s.unit_id
      WHERE s.company_id = ? ORDER BY s.name COLLATE NOCASE`,
    [companyId],
  );

  const fetch = (op, date) => all(
    `SELECT i.stock_item_id, i.direction, SUM(i.quantity) AS qty, SUM(i.amount) AS amt
       FROM voucher_inventory i JOIN vouchers v ON v.id = i.voucher_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0 AND v.is_optional = 0
        AND v.date ${op} ?
      GROUP BY i.stock_item_id, i.direction`,
    [companyId, date],
  );

  const inPeriod = await all(
    `SELECT i.stock_item_id, i.direction, SUM(i.quantity) AS qty, SUM(i.amount) AS amt
       FROM voucher_inventory i JOIN vouchers v ON v.id = i.voucher_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0 AND v.is_optional = 0
        AND v.date >= ? AND v.date <= ?
      GROUP BY i.stock_item_id, i.direction`,
    [companyId, p.from, p.to],
  );
  const before = await fetch('<', p.from);

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
  const rows = await all(
    `SELECT b.*, l.name AS ledger_name, v.date, v.id AS voucher_id,
            vt.name AS voucher_type_name, g.name AS group_name
       FROM bill_allocations b
       JOIN vouchers v ON v.id = b.voucher_id
       JOIN voucher_types vt ON vt.id = v.voucher_type_id
       JOIN ledgers l ON l.id = b.ledger_id
       JOIN groups g ON g.id = l.group_id
      WHERE v.company_id = ? AND v.is_deleted = 0 AND v.is_cancelled = 0
        AND v.date <= ? AND g.name = ?
      ORDER BY l.name, v.date`,
    [companyId, p.to, groupName],
  );

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
  const counts = await get(
    `SELECT COUNT(*) AS vouchers,
            SUM(CASE WHEN is_deleted = 1 THEN 1 ELSE 0 END) AS deleted,
            SUM(CASE WHEN is_cancelled = 1 THEN 1 ELSE 0 END) AS cancelled
       FROM vouchers WHERE company_id = ?`,
    [companyId],
  ) || {};
  const edits = await get(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN action = 'Altered' THEN 1 ELSE 0 END) AS altered
       FROM edit_log WHERE company_id = ?`,
    [companyId],
  ) || {};
  return {
    period: p,
    vouchers: toNum(counts.vouchers),
    deletedVouchers: toNum(counts.deleted),
    cancelledVouchers: toNum(counts.cancelled),
    editLogEntries: toNum(edits.total),
    alteredEntries: toNum(edits.altered),
    sales: pl.summary.sales,
    purchases: pl.summary.purchases,
    netProfit: pl.summary.netProfit,
    closingStock: pl.summary.closingStock,
    balanceSheetTotal: bs.totals.assets,
    difference: bs.totals.difference,
  };
}
