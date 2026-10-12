"""Synthetic external accounting export. Decimal arithmetic; no application imports."""
from pathlib import Path
from decimal import Decimal, ROUND_HALF_UP
import csv, io, json, zipfile, xml.sax.saxutils as xml
OUT=Path(__file__).resolve().parents[1]/'docs/accounting/fixtures/external-export'
OUT.mkdir(parents=True,exist_ok=True)
PROFILE=json.loads((OUT.parent/'directory-shape.json').read_text())
UNITS=PROFILE['premises']
PREMISES=len(UNITS)
RESIDENTIAL=PREMISES-2 # Two last units are hypothetical nonresidential cases, not asserted real types.
OWNERS=sum(len(a['owners']) for a in UNITS)
D=Decimal
def money(x):return D(x).quantize(D('.01'),rounding=ROUND_HALF_UP)
def text(x):return str(x).replace('.',',') if isinstance(x,Decimal) else str(x)
def iban(n):
 b='30529900000260012345'+str(n).zfill(5)
 return 'UA'+str(98-int(b+'301000')%97).zfill(2)+b
BANK,DEP=iban(1),iban(2)
accounts=[['Особовий рахунок','Приміщення','Тип приміщення','Підʼїзд','Загальна площа, м²','Кількість проживаючих','Сальдо Дт, грн','Сальдо Кт, грн','Дата залишків']]
owners=[['Приміщення','ПІБ співвласника','Частка','Документ про право власності']]
fees=[['Місяць','Особовий рахунок','Приміщення','Площа, м²','Ставка за м², грн','Проживаючі','Ставка з особи, грн','Нараховано, грн']]
ledger=[['Дата','Документ','Особовий рахунок','Приміщення','Операція','Сума, грн']]
opening=[['Рахунок','Субконто','Сальдо Дт, грн','Сальдо Кт, грн']]
journal=[['Дата','Документ','Рахунок Дт','Субконто Дт','Рахунок Кт','Субконто Кт','Сума, грн','Зміст']]
monthly={p:[] for p in ['2026-10','2026-11','2026-12']}
bankrows=[['Дата','Референс','IBAN ОСББ','Дебет (списання), грн','Кредит (надходження), грн','Отримувач / платник','IBAN контрагента','Код контрагента','Призначення']]
initial_bank=D('1500000');initial_deposit=D('500000');creditor=D('25000');initial_receivable=D(0)
current_bank=initial_bank;current_deposit=initial_deposit;current_receivable=D(0)
charged=paid=D(0);expected={};fee_sum=D(0)
for i in range(1,PREMISES+1):
 unit=UNITS[i-1]
 apt=unit['apt']
 account='000'+str(700000+i)
 area=D(unit['area']) if unit['area'] else D(3500+(i*137)%6500)/100;residents=1+i%4 if i<=RESIDENTIAL else 0
 rate=D('6.10') if i<=RESIDENTIAL else D('7.20');fee=money(area*rate+D('14.15')*residents)
 jan=money(D((i%7-3)*125)) # Positive = debtor's debit, negative = advance credit.
 payment=money(fee+(D('75') if i%5==0 else -D('100') if i%6==0 else D(0)))
 initial_receivable+=jan;closing=jan+fee-payment
 charged+=fee;paid+=payment;current_receivable+=closing;current_bank+=payment;fee_sum+=fee
 opening.append(['377',account,max(jan,D(0)),max(-jan,D(0))])
 accounts.append([account,apt,'Житлове' if i<=RESIDENTIAL else 'Нежитлове',unit['entrance'] or 1+(i-1)//101,area,residents,max(closing,D(0)),max(-closing,D(0)),'30.09.2026'])
 for n,o in enumerate(unit['owners']):owners.append([apt,'Тестовий співвласник '+o['alias'],o['share'],f'Синтетичний витяг № TEST-{i}-{n+1}'])
 fees.append(['2026-09',account,apt,area,rate,residents,D('14.15'),fee])
 ledger.extend([['01.09.2026',f'Н-09-{i}',account,apt,'Нарахування',fee],['20.09.2026',f'О-09-{i}',account,apt,'Оплата',payment]])
 journal.extend([['01.09.2026',f'Н-09-{i}','377',account,'48','Внески на утримання',fee,'Внесок за вересень'],['20.09.2026',f'О-09-{i}','311',BANK,'377',account,payment,'Оплата внеску']])
 expected[apt]={'account':account,'area':str(area),'residents':residents,'openingKop':int(-closing*100),'feeKop':int(fee*100),'months':{}}
 balance=-closing
 for month in monthly:
  amount=money(fee+(D('20') if i%11==0 else -D('30') if i%13==0 else D(0)))
  if i%17==0:amount=D(0)
  balance+=amount-fee
  expected[apt]['months'][month]={'paymentKop':int(amount*100),'closingKop':int(balance*100)}
  if amount:bankrows.append([month+'-20',f'TEST-{month}-{i}',BANK,D(0),amount,f'Тестовий платник {i}',iban(10000+i),'',f'Внесок на утримання, о/р {account}, {month}'])
initial_fund=initial_bank+initial_deposit+initial_receivable-creditor
opening.extend([['311',BANK,initial_bank,D(0)],['351',DEP,initial_deposit,D(0)],['631','30000005',D(0),creditor],['48','Внески на утримання',D(0),initial_fund]])
journal.extend([['25.09.2026','АКТ-09','92','Утримання','631','30000005',D('20000'),'Послуги вересня'],['26.09.2026','П-09','631','30000005','311',BANK,D('20000'),'Оплата послуг'],['30.09.2026','ВФ-09','48','Внески на утримання','719','',D('20000'),'Використане фінансування'],['30.09.2026','ЗД-09','719','','79','',D('20000'),'Закриття доходів'],['30.09.2026','ЗВ-09','79','','92','Утримання',D('20000'),'Закриття витрат']])
current_bank-=D('20000')
cut=[['Рахунок','Субконто','Сальдо Дт, грн','Сальдо Кт, грн']]
for r in accounts[1:]:cut.append(['377',r[0],r[6],r[7]])
cut.extend([['311',BANK,current_bank,D(0)],['351',DEP,current_deposit,D(0)],['631','30000005',D(0),creditor],['48','Внески на утримання',D(0),initial_fund+charged-D('20000')]])
for month in monthly:
 bankrows.extend([[month+'-22',f'TEST-{month}-deposit-out',BANK,D('10000'),D(0),'Власний депозит',DEP,'12345678','Переказ між власними рахунками'],[month+'-22',f'TEST-{month}-deposit-in',DEP,D(0),D('10000'),'Власний поточний рахунок',BANK,'12345678','Переказ між власними рахунками'],[month+'-28',f'TEST-{month}-interest',BANK,D(0),D('500'),'Банк','','14360570','Проценти за депозитом']])
suppliers=[['Код контрагента','Назва контрагента','IBAN','Вид'],['30000005','ТОВ «Синтетичний постачальник»',iban(3),'company']]
legacy_docs=[['Код контрагента','Номер документа','Дата документа','Період','Сума документа, грн','Сплачено, грн'],['30000005','LEGACY-2025-12','15.12.2025','2025-12',D('30000'),D('5000')]]
new_docs=[['Код контрагента','Номер документа','Дата документа','Період','Сума документа, грн']]
for month in monthly:
 new_docs.append(['30000005','SERVICE-'+month,month+'-05',month,D('1000')])
 bankrows.append([month+'-25','TEST-'+month+'-supplier',BANK,D('1000'),D(0),'ТОВ «Синтетичний постачальник»',iban(3),'30000005','Оплата SERVICE-'+month])
bankrows.append(['2026-10-10','TEST-legacy-payment',BANK,creditor,D(0),'ТОВ «Синтетичний постачальник»',iban(3),'30000005','Оплата LEGACY-2025-12'])
employees=[['Табельний номер','ПІБ','РНОКПП','IBAN','Оклад, грн','Дата прийому'],['TEST-1','Працівник Тестовий','3124567809',iban(4),D('10000'),'2026-01-01']]
control={'synthetic':True,'premises':PREMISES,'apartments':RESIDENTIAL,'nonresidential':PREMISES-RESIDENTIAL,'owners':len(owners)-1,'uniqueOwnerAliases':len({r[1] for r in owners[1:]}),'startDate':'2026-10-01','bank':BANK,'deposit':DEP,'cutBankKop':int(current_bank*100),'cutDepositKop':int(current_deposit*100),'cutDebtNetKop':int(current_receivable*100),'monthlyChargesKop':int(fee_sum*100),'priorIncomeKop':2000000,'priorCostsKop':2000000,'apartmentsExpected':expected}
sheets={'Особові рахунки':accounts,'Співвласники':owners,'Нарахування вересня':fees,'Історія особових':ledger,'ОСВ на 01 січня':opening,'Журнал до переходу':journal,'ОСВ на 30 вересня':cut,'Виписка жовтень-грудень':bankrows,'Контрагенти':suppliers,'Незакриті документи':legacy_docs,'Послуги кварталу':new_docs,'Працівники':employees}
filenames={}
for i,(name,rows) in enumerate(sheets.items(),1):
 filename=f'{i:02d}-{name}.csv';filenames[name]=filename
 with (OUT/filename).open('w',encoding='utf-8-sig',newline='') as f:csv.writer(f,delimiter=';').writerows([[text(x) for x in r] for r in rows])
# Standard OOXML written independently from the application.
def col(i):
 s=''
 while i:i,r=divmod(i-1,26);s=chr(65+r)+s
 return s
with zipfile.ZipFile(OUT/'test-house-external-export.xlsx','w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+''.join(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' for i in range(1,len(sheets)+1))+'</Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'+''.join(f'<sheet name="{xml.escape(name)}" sheetId="{i}" r:id="rId{i}"/>' for i,name in enumerate(sheets,1))+'</sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+''.join(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>' for i in range(1,len(sheets)+1))+'</Relationships>')
 for i,(name,rows) in enumerate(sheets.items(),1):
  body=[]
  for n,row in enumerate(rows,1):
   cells=[]
   for j,v in enumerate(row,1):
    ref=col(j)+str(n)
    if isinstance(v,(Decimal,int)):cells.append(f'<c r="{ref}"><v>{v}</v></c>')
    else:cells.append(f'<c r="{ref}" t="inlineStr"><is><t>{xml.escape(str(v))}</t></is></c>')
   body.append(f'<row r="{n}">'+''.join(cells)+'</row>')
  z.writestr(f'xl/worksheets/sheet{i}.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+''.join(body)+'</sheetData></worksheet>')
(OUT/'expected-controls.json').write_text(json.dumps(control,ensure_ascii=False,indent=2)+'\n')
with zipfile.ZipFile(OUT/'test-house-external-export.zip','w',zipfile.ZIP_DEFLATED) as z:
 for file in sorted(OUT.iterdir()):
  if file.suffix in ['.csv','.xlsx','.json']:z.write(file,file.name)
print(json.dumps({k:v for k,v in control.items() if k!='apartmentsExpected'},ensure_ascii=False,indent=2))
