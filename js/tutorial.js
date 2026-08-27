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

// Замість запису екрана — мініатюра інтерфейсу, зібрана з тих самих
// стилів і оживлена CSS. Гіфка тієї ж довжини важила б сотні кілобайт
// і мулила б на телефоні; тут кілька кілобайт, чітко на будь-якій
// щільності пікселів і працює офлайн.
//
// Сцена перемальовується разом із кроком, тож анімація щоразу
// починається спочатку — без жодного коду перезапуску.
const SCENES = {
    hello: `
        <div class="sc-bar">
            <span class="sc-logo"></span>
            <span class="sc-name"></span>
            <span class="sc-bell"></span>
        </div>
        <div class="sc-hero">
            <span class="sc-hero-cap"></span>
            <span class="sc-hero-num">298</span>
            <span class="sc-hero-strip"><i></i><i></i><i></i></span>
        </div>`,

    money: `
        <div class="sc-bal">
            <span class="sc-bal-cap"></span>
            <span class="sc-bal-sum">6 247,33</span>
            <span class="sc-bal-btns"><i class="sc-pay"></i><i class="sc-rec"></i></span>
            <span class="sc-tap"></span>
        </div>
        <div class="sc-sheet"><i></i><i></i><i></i></div>`,

    talk: `
        <div class="sc-chat">
            <span class="sc-msg sc-msg-in"></span>
            <span class="sc-msg sc-msg-out"></span>
            <span class="sc-msg sc-msg-in sc-msg-in2"></span>
        </div>
        <span class="sc-badge">1</span>`,

    owners: `
        <div class="sc-head">
            <span class="sc-head-title"></span>
            <span class="sc-chip">
                <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                звірено
            </span>
        </div>
        <div class="sc-own sc-own1"><span class="sc-av"></span><span class="sc-lines"><i></i><i></i></span><span class="sc-share">1/2</span></div>
        <div class="sc-own sc-own2"><span class="sc-av sc-av2"></span><span class="sc-lines"><i></i><i></i></span><span class="sc-share">1/2</span></div>`
};

const STEPS = [
    {
        scene: 'hello',
        title: 'Вітаємо у застосунку ОСББ',
        text: 'Тут усе про ваш будинок і вашу квартиру: платежі, звернення до правління, '
            + 'голосування та новини. Пароль ви щойно змінили — більше ніхто, крім вас, у цю квартиру не зайде.'
    },
    {
        scene: 'money',
        title: 'Ваші платежі',
        text: 'На головному екрані видно борг або переплату. Поруч — реквізити для оплати '
            + 'з готовим призначенням платежу, ваші квитанції та історія нарахувань.'
    },
    {
        scene: 'talk',
        title: 'Звʼязок із правлінням',
        text: 'Зламався ліфт, протікає дах, є питання — напишіть звернення, і правління відповість '
            + 'просто тут. Оголошення для всього будинку приходять у дзвіночок угорі екрана.'
    },
    {
        scene: 'owners',
        title: 'Найважливіше — список власників',
        text: 'Рішення ОСББ ухвалюють співвласники, і голос кожного важить рівно стільки, '
            + 'скільки його частка. Перевірте свій список — це одна хвилина.',
        cta: 'Перевірити список'
    }
];

// ⚠️ ТИМЧАСОВО, ДЛЯ ПЕРЕВІРКИ.
// Показує знайомство при КОЖНОМУ вході з логіна й пароля, а не лише
// першого разу. Перед запуском для мешканців повернути на false —
// більше нічого міняти не треба.
const ALWAYS_SHOW_ON_LOGIN = true;

// Саме «вхід», а не «завантаження екрана»: кабінет перечитується
// й після оновлення жестом, і тур вискакував би щоразу.
let freshLogin = false;

/** Викликається одразу після успішного входу логіном і паролем. */
export function markFreshLogin() {
    freshLogin = true;
}

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
        <div class="tut-scene sc-${s.scene}" aria-hidden="true">${SCENES[s.scene]}</div>
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
    if (session.isAdmin) return;
    const force = ALWAYS_SHOW_ON_LOGIN && freshLogin;
    freshLogin = false;               // одноразово, хай там як
    if (!force && session.tutorialSeen) return;
    const host = overlay();
    if (!host) return;
    step = 0;
    host.hidden = false;
    lockScroll();
    render();
}
