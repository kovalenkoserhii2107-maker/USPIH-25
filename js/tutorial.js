// ============================================================
// Знайомство із застосунком при першому вході.
//
// Показуємо накладкою поверх уже завантаженого кабінету, а не
// окремим екраном: коли мешканець дійде до останнього кроку,
// список співвласників уже на місці — лишається доїхати до нього.
//
// Чотири кроки, не більше. Половині будинку за сімдесят, і довгий
// тур вони просто закриють — разом із тим, заради чого він потрібен.
// ============================================================
import { db, session, currentApt } from './firebase.js';
import {
    doc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { escapeHtml, lockScroll, unlockScroll } from './ui.js';

const icon = (paths) =>
    `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor"
          stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

const STEPS = [
    {
        tone: 'blue',
        icon: icon('<path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z"></path><path d="M9 21v-8h6v8"></path>'),
        title: 'Вітаємо у застосунку ОСББ',
        text: 'Тут усе про ваш будинок і вашу квартиру: платежі, звернення до правління, '
            + 'голосування та новини. Пароль ви щойно змінили — більше ніхто, крім вас, у цю квартиру не зайде.'
    },
    {
        tone: 'green',
        icon: icon('<rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line>'),
        title: 'Ваші платежі',
        text: 'На головному екрані видно борг або переплату. Поруч — реквізити для оплати '
            + 'з готовим призначенням платежу, ваші квитанції та історія нарахувань за будь-який місяць.'
    },
    {
        tone: 'orange',
        icon: icon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>'),
        title: 'Звʼязок із правлінням',
        text: 'Зламався ліфт, протікає дах, є питання — напишіть звернення, і правління відповість '
            + 'просто тут. Оголошення для всього будинку приходять у дзвіночок угорі екрана.'
    },
    {
        tone: 'purple',
        icon: icon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><polyline points="16 11 18 13 22 9"></polyline>'),
        title: 'Найважливіше — список власників',
        text: 'Рішення ОСББ ухвалюють співвласники, і голос кожного важить рівно стільки, '
            + 'скільки його частка. Щоб голосування було чесним, список має бути точним. '
            + 'Перевірте свій — це одна хвилина.',
        cta: 'Перевірити список'
    }
];

let step = 0;

const overlay = () => document.getElementById('tutorialOverlay');

function render() {
    const host = overlay();
    if (!host) return;
    const s = STEPS[step];
    const last = step === STEPS.length - 1;

    host.querySelector('.tut-card').innerHTML = `
        <div class="tut-dots" role="progressbar"
             aria-valuenow="${step + 1}" aria-valuemin="1" aria-valuemax="${STEPS.length}">
            ${STEPS.map((_, i) => `<i class="${i === step ? 'is-on' : ''}"></i>`).join('')}
        </div>
        <div class="tut-icon tut-${s.tone}">${s.icon}</div>
        <h2 class="tut-title">${escapeHtml(s.title)}</h2>
        <p class="tut-text">${escapeHtml(s.text)}</p>
        <button type="button" class="btn-primary tut-next">${escapeHtml(s.cta || 'Далі')}</button>
        <div class="tut-foot">
            ${step > 0
                ? '<button type="button" class="tut-link tut-back">Назад</button>'
                : '<span></span>'}
            ${last
                ? '<span></span>'
                : '<button type="button" class="tut-link tut-skip">Пропустити</button>'}
        </div>`;

    host.querySelector('.tut-next').addEventListener('click', () => {
        if (last) finish(true); else { step++; render(); }
    });
    host.querySelector('.tut-back')?.addEventListener('click', () => { step--; render(); });
    // Пропустити — теж завершення: нагадування про список лишається
    // смужкою вгорі кабінету, тож нічого не втрачено, а вдруге тур
    // не повториться. Змушувати гортати до кінця — не наша справа.
    host.querySelector('.tut-skip')?.addEventListener('click', () => finish(false));
}

async function finish(goToOwners) {
    const host = overlay();
    if (host) { host.hidden = true; unlockScroll(); }
    session.tutorialSeen = true;

    if (goToOwners) {
        // Даємо накладці зникнути, і аж тоді прокручуємо
        setTimeout(() => {
            document.querySelector('.owners-block')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 60);
    }

    // Позначку пишемо в базу, але екран її не чекає: якщо мережа
    // підведе, тур просто зʼявиться ще раз — це не привід тримати
    // людину перед вимкненою кнопкою.
    try {
        await updateDoc(doc(db, 'apartments', currentApt()), { tutorialAt: serverTimestamp() });
    } catch (e) {
        console.warn('Позначка про тур:', e);
    }
}

/** Показує знайомство, якщо мешканець його ще не бачив. */
export function maybeShowTutorial() {
    if (session.isAdmin || session.tutorialSeen) return;
    const host = overlay();
    if (!host) return;
    step = 0;
    host.hidden = false;
    lockScroll();
    render();
}
