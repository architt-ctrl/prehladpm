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

// ── Reálny priebeh pri preťažení ─────────────────────────────────────────────
// Zadané trvanie platí, keď má práca k dispozícii plnú zadanú alokáciu. Keď má človek v niektorý
// deň naraz viac práce než 100 %, práce sa reálne spomalia a ich koniec sa posunie za nominálny.
// Pravidlo delenia kapacity (Jozef): práca s pevným termínom (prioritny) sa robí prednostne naplno;
// ostatné si delia zvyšok pomerne. Ak majú termín všetky prekryté práce (alebo žiadna), delia sa
// pomerne všetky. Automatický plánovač preťaženie sám nevytvára - vzniká len ručne zadanými štartmi.
function harmDenKey(projektant, datum) {
  return `${projektant}|${datum.getFullYear()}-${datum.getMonth() + 1}-${datum.getDate()}`;
}

// priradenia: [{projektant, start_datum: Date, trvanie_tyzdne, alokacia_percent, prioritny, ...}]
// Vracia { priradenia: kópie s realny_koniec (Date) a spomalene (bool),
//          usage: Map(harmDenKey -> reálne odpracované % v daný deň) }.
// Simulácia po dňoch: každá práca potrebuje trvanie*7*alokácia "percento-dní" úsilia; denne dostane
// najviac svoju alokáciu, pri preťažení menej (podľa pravidla vyššie), takže dobieha dlhšie.
function harmSimulujRealne(priradenia) {
  const kopie = priradenia
    .filter(p => p.start_datum && (p.trvanie_tyzdne > 0 || (p.koniec_datum && p.koniec_datum > p.start_datum)))
    .map(p => Object.assign({}, p, {
      realny_koniec: null,
      spomalene: false,
      // trvanie sa dá odvodiť aj z koniec_datum (záznamy bez explicitného trvania)
      _trv: p.trvanie_tyzdne > 0 ? p.trvanie_tyzdne : (p.koniec_datum - p.start_datum) / HARM_TYZDEN_MS,
    }));
  const usage = new Map();
  const perProjektant = {};
  kopie.forEach(k => { (perProjektant[k.projektant] = perProjektant[k.projektant] || []).push(k); });

  Object.keys(perProjektant).forEach(meno => {
    const list = perProjektant[meno];
    list.forEach(k => { k._zostava = k._trv * 7 * k.alokacia_percent; });
    let den = new Date(Math.min(...list.map(k => k.start_datum.getTime())));
    const limit = den.getTime() + 5 * 365 * HARM_DEN_MS; // poistka proti nekonečnej slučke
    while (list.some(k => !k.realny_koniec) && den.getTime() < limit) {
      const aktivne = list.filter(k => !k.realny_koniec && k.start_datum <= den);
      if (aktivne.length) {
        // Poradie nárokov na denných 100 %:
        // 1. práce s termínom (prioritny) pred bežnými
        // 2. v rámci skupiny: kto začal skôr, drží svoje tempo; neskorší berú len zvyšok
        //    ("voľná kapacita sa vždy využije - práca začne hneď a dokončí sa neskôr")
        // 3. rovnaký deň štartu: delia sa pomerne ("robia sa naraz")
        const pridelene = new Map();
        let kapacita = 100;
        const rozdel = skupina => {
          const sum = skupina.reduce((s, k) => s + k.alokacia_percent, 0);
          if (!sum || kapacita <= 0) { skupina.forEach(k => pridelene.set(k, 0)); return; }
          const f = Math.min(1, kapacita / sum);
          skupina.forEach(k => pridelene.set(k, k.alokacia_percent * f));
          kapacita -= Math.min(kapacita, sum);
        };
        [aktivne.filter(k => k.prioritny), aktivne.filter(k => !k.prioritny)].forEach(trieda => {
          const podlaStartu = {};
          trieda.forEach(k => { (podlaStartu[k.start_datum.getTime()] = podlaStartu[k.start_datum.getTime()] || []).push(k); });
          Object.keys(podlaStartu).map(Number).sort((x, y) => x - y).forEach(t => rozdel(podlaStartu[t]));
        });
        let sucet = 0;
        aktivne.forEach(k => {
          const g = pridelene.get(k) || 0;
          if (g < k.alokacia_percent - 1e-9) k.spomalene = true;
          k._zostava -= g;
          sucet += g;
          if (k._zostava <= 1e-6) k.realny_koniec = new Date(den.getTime() + HARM_DEN_MS);
        });
        if (sucet > 0) usage.set(harmDenKey(meno, den), sucet);
      }
      den = new Date(den.getTime() + HARM_DEN_MS);
    }
    list.forEach(k => { if (!k.realny_koniec) k.realny_koniec = new Date(limit); delete k._zostava; delete k._trv; });
  });
  return { priradenia: kopie, usage };
}

// Denná verzia kontroly kapacity - namiesto intervalových súčtov číta usage mapu zo simulácie,
// takže rešpektuje aj nerovnomerne rozloženú (spomalenú) prácu.
function harmJeKapacitaVolnaDni(usage, projektant, start, koniec, potrebnaAlokacia, maxPercent) {
  maxPercent = maxPercent || 100;
  for (let t = start.getTime(); t < koniec.getTime(); t += HARM_DEN_MS) {
    const obsadene = usage.get(harmDenKey(projektant, new Date(t))) || 0;
    if (obsadene + potrebnaAlokacia > maxPercent + 1e-9) return false;
  }
  return true;
}

function harmNajdiNajskorsiStartDni(usage, projektant, najskorMozny, trvanieTyzdne, alokaciaPercent, maxPercent) {
  let kandidat = new Date(najskorMozny);
  const limit = harmPridajTyzdne(kandidat, 104);
  while (kandidat < limit) {
    const koniec = harmPridajTyzdne(kandidat, trvanieTyzdne);
    if (harmJeKapacitaVolnaDni(usage, projektant, kandidat, koniec, alokaciaPercent, maxPercent)) {
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

// Tiebreak pre bloky (podpodfázy) tej istej fázy: musia sa plánovať v poradí 1,2,3
// (príprava -> koordinácia -> dopracovanie), inak by reťazenie nižšie nemalo z čoho vychádzať.
function harmPoradieTiebreak(a, b) {
  if (a.cislo === b.cislo && a.faza_kod === b.faza_kod) return (a.poradie || 0) - (b.poradie || 0);
  return 0;
}

function harmZoradPodlaPriority(nenaplanovane) {
  return [...nenaplanovane].sort((a, b) => {
    if (!!a.prioritny !== !!b.prioritny) return a.prioritny ? -1 : 1;
    if (a.prioritny && b.prioritny) {
      const da = a.termin_klient ? a.termin_klient.getTime() : Infinity;
      const db = b.termin_klient ? b.termin_klient.getTime() : Infinity;
      if (da !== db) return da - db;
    }
    return harmZoradPodlaOzvani(a, b) || harmPoradieTiebreak(a, b);
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
  const vysledky = [];

  // Reálny priebeh existujúcich naplánovaných prác: pri ručne zadaných prekryvoch nad 100 %
  // sa práce spomalia a ich konce posunú - nové plánovanie aj reťazenie blokov musí vychádzať
  // z týchto reálnych koncov, nie z nominálnych (start + trvanie).
  const sim = harmSimulujRealne(existujuceNaplanovane);
  const usage = sim.usage;

  // Dni, v ktorých už niekto štartuje (existujúce aj novo naplánované) - nová práca v ten deň
  // u toho istého človeka nezačne (viď komentár pri naplanujDoVolnychKapacit).
  const startyPodlaDna = new Set();
  existujuceNaplanovane.forEach(e => {
    if (e.start_datum) startyPodlaDna.add(harmDenKey(e.projektant, e.start_datum));
  });

  // Nájde prvý deň s voľnou kapacitou a odsimuluje dopĺňanie práce do voľných zvyškov dní.
  // Vracia {start, koniec, spomalene}; commitne spotrebu priamo do usage mapy.
  function naplanujDoVolnychKapacit(a, najskorMozny) {
    const limitStart = harmPridajTyzdne(najskorMozny, 104);
    let d = new Date(najskorMozny);
    while (d < limitStart) {
      const volne = maxPercent - (usage.get(harmDenKey(a.projektant, d)) || 0);
      if (volne > 1e-9 && !startyPodlaDna.has(harmDenKey(a.projektant, d))) break;
      d = new Date(d.getTime() + HARM_DEN_MS);
    }
    if (d >= limitStart) return { start: null, koniec: null, spomalene: false };

    const start = d;
    let zostava = a.trvanie_tyzdne * 7 * a.alokacia_percent;
    const limitKoniec = start.getTime() + 5 * 365 * HARM_DEN_MS;
    const spotreba = []; // [kľúč, koľko] - commit až keď je isté, že sa práca stihne celá
    while (zostava > 1e-6 && d.getTime() < limitKoniec) {
      const kluc = harmDenKey(a.projektant, d);
      const volne = maxPercent - (usage.get(kluc) || 0);
      const g = Math.min(a.alokacia_percent, Math.max(0, volne), zostava);
      if (g > 1e-9) { spotreba.push([kluc, g]); zostava -= g; }
      d = new Date(d.getTime() + HARM_DEN_MS);
    }
    if (zostava > 1e-6) return { start: null, koniec: null, spomalene: false };
    spotreba.forEach(([kluc, g]) => usage.set(kluc, (usage.get(kluc) || 0) + g));
    const koniec = d;
    const nominal = harmPridajTyzdne(start, a.trvanie_tyzdne);
    return { start, koniec, spomalene: koniec.getTime() > nominal.getTime() + 1 };
  }

  // Reťazenie blokov VNÚTRI jednej fázy: bloky (podpodfázy) na seba nadväzujú prirodzene bez
  // vonkajšieho medzikroku, na rozdiel od reťazenia medzi fázami (to ostáva zakázané - viď
  // harmNajskorMoznyStart). Koniec každého bloku s koncom sa eviduje tu; blok s poradie > 1
  // môže začať najskôr po konci VŠETKÝCH predchádzajúcich blokov tej istej fázy.
  const blokKey = b => `${b.cislo}|${b.faza_kod}|${b.poradie}`;
  const konceBlokov = new Map();
  sim.priradenia.forEach(e => {
    if (e.podpodfaza && e.realny_koniec) konceBlokov.set(blokKey(e), e.realny_koniec);
  });
  const vsetkyBloky = nenaplanovane.concat(existujuceNaplanovane).filter(b => b.podpodfaza);

  zoradene.forEach(a => {
    let najskor = harmNajskorMoznyStart(a, dnes);

    if (a.podpodfaza && a.poradie > 1) {
      const predosle = vsetkyBloky.filter(b =>
        b.cislo === a.cislo && b.faza_kod === a.faza_kod && b.poradie < a.poradie);
      let blokovane = false;
      predosle.forEach(p => {
        const kon = konceBlokov.get(blokKey(p));
        if (!kon) blokovane = true;
        else if (kon > najskor) najskor = kon;
      });
      if (blokovane) {
        // predchádzajúci blok sa nepodarilo naplánovať (alebo nie je pripravený) - tento nemôže dostať termín
        vysledky.push(Object.assign({}, a, { navrhovany_start: null, navrhovany_koniec: null, caka_na_predoslu: true }));
        return;
      }
    }

    // Voľná kapacita sa vždy využije: práca začne v prvý deň, keď je u projektanta čokoľvek voľné,
    // denne si berie min(vlastná alokácia, voľný zvyšok) a dokončí sa, keď vyčerpá svoje úsilie -
    // pri čiastočnom súbehu teda reálne trvá dlhšie než nominál (start + trvanie). Nikdy pritom
    // nespomalí skôr začaté práce (berie len zvyšok). Deň, keď štartuje iná práca toho istého
    // človeka, sa preskočí - pravidlo "rovnaký deň štartu = pomerné delenie" by inak spomalilo
    // existujúcu prácu a plán by nesedel s prepočtom pri ďalšom načítaní.
    const plan = naplanujDoVolnychKapacit(a, najskor);
    const vysledok = Object.assign({}, a, {
      navrhovany_start: plan.start,
      navrhovany_koniec: plan.koniec,
      navrhovane_spomalene: plan.spomalene,
    });
    vysledky.push(vysledok);
    if (plan.start) {
      startyPodlaDna.add(harmDenKey(a.projektant, plan.start));
      if (a.podpodfaza) konceBlokov.set(blokKey(a), plan.koniec);
    }
  });

  [...nepripravene].sort(harmZoradPodlaOzvani).forEach(a => {
    vysledky.push(Object.assign({}, a, { navrhovany_start: null, navrhovany_koniec: null }));
  });

  return vysledky;
}

// ── Prepojenie na ponuky.html (podklady_datum) ──────────────────────────────
// MVP predpoklad: podklady pre externistov sú k dispozícii hneď na začiatku internej fázy
// Presné pravidlo podľa tabulky/fázovanie projektu.gsheet: podklady pre externistov sú hotové presne vtedy,
// keď skončí podpodfáza "príprava pre profesie" danej podfázy (SZ/PS/RP) - nie na začiatku celej fázy.
// Pre iné podpodfázy (koordinácia s profesiami, dopracovanie dokumentácie) sa podklady_datum nenavrhuje vôbec.
function harmNavrhniPodkladyDatum(harmonogramZaznam) {
  if (harmonogramZaznam.podpodfaza !== 'príprava pre profesie') return null;
  return harmonogramZaznam.koniec_datum || harmonogramZaznam.navrhovany_koniec || null;
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
    harmDenKey, harmSimulujRealne, harmJeKapacitaVolnaDni, harmNajdiNajskorsiStartDni,
    harmNajskorMoznyStart, harmZoradPodlaOzvani, harmPoradieTiebreak, harmZoradPodlaPriority, harmNaplanujFrontu,
    harmNavrhniPodkladyDatum, harmNajdiNavrhyPreDopyty,
  };
}
