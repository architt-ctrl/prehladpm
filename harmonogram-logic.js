// Harmonogram: čistá logika kapacitného plánovania interného tímu.
// Žiadny DOM, žiadne UI - len funkcie nad dátami, aby sa dali samostatne testovať.
// Vstupné/výstupné dátumy sú JS Date objekty (nie stringy).

const HARM_TYZDEN_MS = 7 * 24 * 60 * 60 * 1000;
const HARM_DEN_MS = 24 * 60 * 60 * 1000;

function harmPridajTyzdne(datum, tyzdne) {
  return new Date(datum.getTime() + tyzdne * HARM_TYZDEN_MS);
}

function harmIntervalyPrekryvaju(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// existujuce: [{projektant, start_datum: Date, koniec_datum: Date, alokacia_percent}]
function harmJeKapacitaVolna(existujuce, projektant, start, koniec, potrebnaAlokacia, maxPercent) {
  maxPercent = maxPercent || 100;
  const obsadene = existujuce
    .filter(e => e.projektant === projektant && e.start_datum && e.koniec_datum &&
      harmIntervalyPrekryvaju(e.start_datum, e.koniec_datum, start, koniec))
    .reduce((sum, e) => sum + e.alokacia_percent, 0);
  return obsadene + potrebnaAlokacia <= maxPercent;
}

// Posúva kandidátsky dátum štartu po dňoch, kým nenájde okno, kde sa alokácia zmestí popod strop
// po celú dobu trvania. Vracia null, ak sa nenašlo do 2 rokov dopredu (ochrana pred nekonečnou slučkou).
function harmNajdiNajskorsiStart(existujuce, projektant, najskorMozny, trvanieTyzdne, alokaciaPercent, maxPercent) {
  let kandidat = new Date(najskorMozny);
  const limit = harmPridajTyzdne(kandidat, 104);
  while (kandidat < limit) {
    const koniec = harmPridajTyzdne(kandidat, trvanieTyzdne);
    if (harmJeKapacitaVolna(existujuce, projektant, kandidat, koniec, alokaciaPercent, maxPercent)) {
      return kandidat;
    }
    kandidat = new Date(kandidat.getTime() + HARM_DEN_MS);
  }
  return null;
}

// Najskorší možný štart danej fázy = dnes, prípadne posunutý na najskor_od (manuálny spodný limit).
// Žiadna fáza sa nereťazí automaticky podľa konca predchádzajúcej - medzi takmer všetkými fázami je reálne
// nejaký vonkajší medzikrok (klient, povolenie/inžiniering...), ktorý nevie žiadny algoritmus odhadnúť.
// najskor_od zadáva človek ručne (napr. "čakáme povolenie okolo tohto dátumu"); prvá fáza projektu (Štúdia)
// ho typicky nemá vyplnený vôbec, keďže nemá na čo čakať - vtedy platí len dnešný dátum.
function harmNajskorMoznyStart(priradenie, dnes) {
  let najskor = new Date(dnes);
  if (priradenie.najskor_od && priradenie.najskor_od > najskor) {
    najskor = priradenie.najskor_od;
  }
  return najskor;
}

// Zoradenie nenaplánovaných priradení podľa priority pred hromadným plánovaním:
// 1. prioritné (záväzný termín s klientom) pred bežnými
// 2. medzi prioritnými: skorší termin_klient prv
// 3. inak: kto sa ozval skôr (ozvali_sa_datum, business dátum prvého kontaktu - nie dátum zápisu do systému),
//    fallback na created_at ak nie je vyplnený
function harmZoradPodlaOzvani(a, b) {
  const oa = a.ozvali_sa_datum ? a.ozvali_sa_datum.getTime() : (a.created_at ? new Date(a.created_at).getTime() : 0);
  const ob = b.ozvali_sa_datum ? b.ozvali_sa_datum.getTime() : (b.created_at ? new Date(b.created_at).getTime() : 0);
  return oa - ob;
}

function harmZoradPodlaPriority(nenaplanovane) {
  return [...nenaplanovane].sort((a, b) => {
    if (!!a.prioritny !== !!b.prioritny) return a.prioritny ? -1 : 1;
    if (a.prioritny && b.prioritny) {
      const da = a.termin_klient ? a.termin_klient.getTime() : Infinity;
      const db = b.termin_klient ? b.termin_klient.getTime() : Infinity;
      if (da !== db) return da - db;
    }
    return harmZoradPodlaOzvani(a, b);
  });
}

// Hlavná funkcia: naplánuje frontu nenaplánovaných priradení voči už existujúcim (naplánovaným) priradeniam.
// nenaplanovane / existujuceNaplanovane: [{cislo, faza_kod, projektant, poradie, trvanie_tyzdne, alokacia_percent,
//   prioritny, termin_klient: Date|null, najskor_od: Date|null, pripravene_pokracovat: boolean, created_at,
//   start_datum: Date|null, koniec_datum: Date|null}]
//
// Dva nezávislé vstupy pre naplánovanie fázy:
// 1. Kapacita - kedy má daný projektant voľno (rieši harmJeKapacitaVolna/harmNajdiNajskorsiStart)
// 2. Pripravenosť projektu - či je vôbec odblokovaný na pokračovanie (klient schválil, povolenie prišlo...).
//    Kým pripravene_pokracovat !== true, fáza sa VÔBEC neplánuje (nedostane navrhovany_start) - ostáva bokom
//    medzi čakajúcimi, aj keby mal projektant kapacitu voľnú. Len čo ju niekto ručne označí ako pripravenú,
//    zaradí sa do plánovania (s najskor_od dátumom, ak je známy, inak od dneška).
//
// Vracia kópiu nenaplanovane s doplnenými poľami navrhovany_start / navrhovany_koniec (Date alebo null pre
// nepripravené položky).
function harmNaplanujFrontu(nenaplanovane, existujuceNaplanovane, dnes, maxPercent) {
  dnes = dnes || new Date();
  maxPercent = maxPercent || 100;

  const pripravene = nenaplanovane.filter(a => a.pripravene_pokracovat);
  const nepripravene = nenaplanovane.filter(a => !a.pripravene_pokracovat);

  const zoradene = harmZoradPodlaPriority(pripravene);
  const commited = existujuceNaplanovane.map(e => Object.assign({}, e));
  const vysledky = [];

  zoradene.forEach(a => {
    const najskor = harmNajskorMoznyStart(a, dnes);
    const start = harmNajdiNajskorsiStart(commited, a.projektant, najskor, a.trvanie_tyzdne, a.alokacia_percent, maxPercent);
    const koniec = start ? harmPridajTyzdne(start, a.trvanie_tyzdne) : null;
    const vysledok = Object.assign({}, a, { navrhovany_start: start, navrhovany_koniec: koniec });
    vysledky.push(vysledok);
    commited.push({ cislo: a.cislo, poradie: a.poradie, projektant: a.projektant, start_datum: start, koniec_datum: koniec, alokacia_percent: a.alokacia_percent });
  });

  [...nepripravene].sort(harmZoradPodlaOzvani).forEach(a => {
    vysledky.push(Object.assign({}, a, { navrhovany_start: null, navrhovany_koniec: null }));
  });

  return vysledky;
}

// ── Prepojenie na ponuky.html (podklady_datum) ──────────────────────────────
// MVP predpoklad: podklady pre externistov sú k dispozícii hneď na začiatku internej fázy
// (nie až na konci) - dá sa neskôr upraviť pridaním offsetu, ak sa ukáže, že to v praxi nesedí.
function harmNavrhniPodkladyDatum(harmonogramZaznam) {
  return harmonogramZaznam.start_datum || harmonogramZaznam.navrhovany_start || null;
}

// harmonogramZaznamy: naplánované/navrhované záznamy (majú faza_kod, cislo, start_datum alebo navrhovany_start)
// requests: dopyty z ponuky.html [{id, project_cislo, phases: [...], podklady_datum: Date|null}]
// Nikdy nenavrhuje prepísať už ručne zadaný podklady_datum - len doplní tam, kde chýba.
function harmNajdiNavrhyPreDopyty(harmonogramZaznamy, requests) {
  const navrhy = [];
  harmonogramZaznamy.forEach(h => {
    const datum = harmNavrhniPodkladyDatum(h);
    if (!datum) return;
    requests.forEach(r => {
      if (r.project_cislo === h.cislo && Array.isArray(r.phases) && r.phases.indexOf(h.faza_kod) !== -1 && !r.podklady_datum) {
        navrhy.push({ request_id: r.id, cislo: h.cislo, faza_kod: h.faza_kod, navrhovany_podklady_datum: datum });
      }
    });
  });
  return navrhy;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    harmPridajTyzdne, harmIntervalyPrekryvaju, harmJeKapacitaVolna, harmNajdiNajskorsiStart,
    harmNajskorMoznyStart, harmZoradPodlaOzvani, harmZoradPodlaPriority, harmNaplanujFrontu,
    harmNavrhniPodkladyDatum, harmNajdiNavrhyPreDopyty,
  };
}
