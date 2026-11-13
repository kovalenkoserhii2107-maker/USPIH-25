// Сервер демо-будинку: справжні модулі functions/*, зібрані для браузера.
// Працюють на базі в памʼяті (js/demo/memdb.js, globalThis.__demoStore):
// склад створюють до boot(), бо модулі беруть посилання на базу під час завантаження.
let functionsIndex = null, accountingTestFactory = null;

export async function boot() {
    if (!globalThis.__demoStore) throw new Error('Спершу створіть демо-базу');
    if (!functionsIndex) {
        functionsIndex = (await import('../../functions/index.js')).default;
        accountingTestFactory = (await import('../../functions/accounting-test.js')).default;
    }
}

const json = v => (v === undefined ? null : JSON.parse(JSON.stringify(v)));

/** Виклик callable-функції так, як його бачить сервер: дані й вхід користувача. */
export async function call(name, data, user) {
    await boot();
    const fn = functionsIndex[name];
    if (typeof fn !== 'function' || !fn.__demoCallable) {
        const e = new Error(`Функція ${name} у демо недоступна`); e.code = 'not-found'; throw e;
    }
    const request = { data: json(data), auth: user ? { uid: user.uid, token: { email: user.email } } : null, rawRequest: { headers: {}, ip: '127.0.0.1' }, acceptsStreaming: false };
    return json(await fn.run(request));
}

/** Тестова бухгалтерія на демо-базі — нею збирається демо-будинок. */
export async function engine(actor) {
    await boot();
    const { admin: db, lib } = globalThis.__demoStore;
    return accountingTestFactory({ db, FieldValue: lib.FieldValue, Timestamp: lib.Timestamp, requireAdmin: async () => actor }).engine('demo', actor);
}

/** Серверні модулі напряму (як у тестовій бухгалтерії) — для наповнення демо-будинку. */
export async function modules(actor) {
    await boot();
    const { admin: db, lib } = globalThis.__demoStore;
    const factories = {
        charges: (await import('../../functions/charges.js')).default, payments: (await import('../../functions/payments.js')).default,
        budget: (await import('../../functions/budget.js')).default, expenses: (await import('../../functions/expenses.js')).default,
        bank: (await import('../../functions/bank.js')).default
    };
    const load = async name => factories[name];
    const lock = (await import('../../functions/period-lock.js')).default(db);
    const deps = { db, FieldValue: lib.FieldValue, Timestamp: lib.Timestamp, requireAdmin: async () => actor, staffRole: async () => 'chair', notify: async () => {}, lock };
    const charges = (await load('charges'))(deps);
    const payments = (await load('payments'))(deps);
    const budget = (await load('budget'))(deps);
    const expenses = (await load('expenses'))({ ...deps, payments, budget });
    const bank = (await load('bank'))({ ...deps, balances: charges, expenses });
    return { charges, payments, budget, expenses, bank };
}
