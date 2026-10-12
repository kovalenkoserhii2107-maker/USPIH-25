// This module (and the Excel reader) is loaded only after choosing a file.
import readExcel from 'read-excel-file/browser';
import {unzipSync,strFromU8} from 'fflate';
import {parseDelimited,textValue,decimalString} from './migration-import-core.js';
const xml=text=>{const d=new DOMParser().parseFromString(text,'application/xml');if(d.getElementsByTagName('parsererror').length)throw new Error('Пошкоджений XML у книзі');return d;};
const all=(d,tag)=>[...d.getElementsByTagNameNS('*',tag)];
function column(ref){const letters=/^[A-Z]+/.exec(ref)?.[0];if(!letters)throw new Error('Некоректна адреса комірки');return [...letters].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;}
export function unpackBounded(bytes){let total=0,count=0;
 return unzipSync(bytes,{filter:f=>{count++;total+=f.originalSize;if(count>250||f.originalSize>12*1024*1024||total>24*1024*1024)throw new Error('Книга завелика після розпакування (до 24 МБ)');return true;}});
}
export async function readImportFile(file,prefix){
 if(file.size>6*1024*1024)throw new Error(`${file.name}: до 6 МБ на файл`);const buffer=await file.arrayBuffer();
 if(/\.(csv|tsv)$/i.test(file.name)){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{text=new TextDecoder('windows-1251').decode(buffer);}return [{id:prefix+'-0',name:file.name,...parseDelimited(text),cells:{}}];}
 if(!/\.xlsx$/i.test(file.name))throw new Error('Оберіть XLSX або CSV/TSV. Старий XLS потрібно зберегти як XLSX');
 const contents=unpackBounded(new Uint8Array(buffer));const get=name=>{if(!contents[name])throw new Error('Книга Excel не містить '+name);return xml(strFromU8(contents[name]));};
 const book=get('xl/workbook.xml'),rels=get('xl/_rels/workbook.xml.rels');const paths=new Map(all(rels,'Relationship').map(r=>[r.getAttribute('Id'),r.getAttribute('Target').replace(/^\/?xl\//,'').replace(/^\//,'')]));
 const sheets=all(book,'sheet');if(sheets.length>24)throw new Error('До 24 листів у книзі');
 const styles=contents['xl/styles.xml']?get('xl/styles.xml'):null,formats=new Map(styles?all(styles,'numFmt').map(n=>[n.getAttribute('numFmtId'),n.getAttribute('formatCode')]):[]);
 const cellXfs=styles?all(styles,'cellXfs')[0]:null;const pads=cellXfs?all(cellXfs,'xf').map(n=>{const f=formats.get(n.getAttribute('numFmtId'))||'';return /^0{2,40}$/.test(f)?f.length:0;}):[];
 const metadata=new Map();let totalCells=0;
 for(const sheet of sheets){const name=sheet.getAttribute('name'),rel=sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');const target=paths.get(rel);if(!target||target.includes('..'))throw new Error('Некоректний шлях листа');const d=get('xl/'+target),cells={};
  for(const r of all(d,'row'))if(r.hasAttribute('r')&&(!/^\d+$/.test(r.getAttribute('r'))||Number(r.getAttribute('r'))>30000))throw new Error('Лист містить рядки за межами 30 000');
  for(const c of all(d,'c')){totalCells++;const ref=c.getAttribute('r')||'',row=Number(ref.replace(/^[A-Z]+/,''))-1,col=column(ref);if(!Number.isInteger(row)||row<0||row>=30000||col>=150||totalCells>300000)throw new Error('Книга: до 30 000 рядків, 150 колонок і 300 000 комірок');
   const type=c.getAttribute('t'),v=all(c,'v')[0]?.textContent,formula=all(c,'f').length>0,numeric=!type||type==='n';cells[`${row}:${col}`]={numeric,unsafeId:numeric&&/^\d{16,}(?:\.0*)?$/.test(decimalString(v||'').replace(/^0+(?=\d)/,'')),padded:numeric&&pads[Number(c.getAttribute('s'))]||0,error:type==='e'||formula&&(v===undefined||v===''),formula};
  }metadata.set(name,cells);
 }
 const result=await readExcel(buffer,{parseNumber:s=>s,trim:false});
 return result.map((sheet,i)=>{const cells=metadata.get(sheet.sheet)||{};const rows=sheet.data.map((r,row)=>r.map((v,col)=>{let s=textValue(v);const m=cells[`${row}:${col}`];if(m?.padded&&/^\d+$/.test(s))s=s.padStart(m.padded,'0');return s;}));return {id:prefix+'-'+i,name:file.name+' / '+sheet.sheet,rows,cells};});
}
