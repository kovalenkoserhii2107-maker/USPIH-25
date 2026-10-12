import {readFile,readdir,writeFile} from 'node:fs/promises';
const directory=new URL('../docs/accounting/fixtures/external-export/',import.meta.url);
const names=await readdir(directory),text=async prefix=>readFile(new URL(names.find(n=>n.startsWith(prefix)),directory),'utf8');
const fields={accounts:'01-',opening:'07-',owners:'02-',ledger:'04-',january:'05-',journal:'06-',suppliers:'09-',legacyExpenses:'10-'};
const files=Object.fromEntries(await Promise.all(Object.entries(fields).map(async([key,prefix])=>[key,await text(prefix)])));
const data={version:1,expected:{finalBankKop:182942975,finalDepositKop:53000000},files,bank:await text('08-'),services:await text('11-'),employee:await text('12-'),controls:JSON.parse(await readFile(new URL('expected-controls.json',directory),'utf8'))};
await writeFile(new URL('../functions/accounting-test-fixture.json',import.meta.url),JSON.stringify(data)+'\n');
