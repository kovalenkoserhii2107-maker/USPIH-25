// Prerequisites unrelated regression tests need before closing their fixture.
export const accountingCollections=['accounting_settings','accounting_notes','journal_opening','journal_snapshots','journal_bank_checks','annual_history','annual_history_versions','annual_history_parts','annual_package_parts','annual_comparatives'];
export async function clearAccounting(db) {
    for(const name of accountingCollections)for(const d of (await db.collection(name).get()).docs)await db.recursiveDelete(d.ref);
}
export async function completeClosingPrerequisites(journal,db,period='2026-10') {
    if(!(await db.doc('accounting_settings/main').get()).exists)await journal.actions.savePolicy('10','chair',{startDate:'2026-10-01',funds:[{id:'main',name:'Основний фонд'}],defaultFund:'main',reportingForm:'micro',basis:'Рішення тестового правління',approve:true});
    const opening=await journal.actions.openingContext();
    if(opening.status!=='approved') {
        const diff=opening.totals.autoDr-opening.totals.autoCr;
        await journal.actions.saveOpening('900','accountant',{lines:diff?[{acc:'48',a:'main',side:diff>0?'cr':'dr',kop:Math.abs(diff)}]:[]});
        await journal.actions.approveOpening('10','chair');
    }
    const ctx=await journal.actions.context({period});
    if(ctx.bankRows.length)await journal.actions.bankCut('900','accountant',{period,rows:ctx.bankRows,note:'Тестова виписка на кінець місяця'});
}
