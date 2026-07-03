// Harmonogram: napojenie čistej logiky (harmonogram-logic.js) na Supabase.
// Číta/zapisuje tabuľku `harmonogram` (supabase/harmonogram-setup.sql), číta `requests` z ponuky.html
// pre návrh podklady_datum. Žiadne UI - volateľné z konzoly / budúceho UI modulu.
// Vyžaduje, aby bola tabuľka harmonogram v Supabase už vytvorená (supabase/harmonogram-setup.sql).

(function (root) {
  const logic = (typeof module !== 'undefined' && module.exports) ? require('./harmonogram-logic') : root;

  function harmParseDate(s) {
    return s ? new Date(s + 'T00:00:00') : null;
  }

  function harmFormatDate(d) {
    if (!d) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  // DB riadok (stringové dátumy) -> tvar pre harmonogram-logic.js (Date objekty) + odvodený koniec_datum
  // (tabuľka koniec_datum neukladá, len start_datum + trvanie_tyzdne).
  function harmRowToLogic(row) {
    const start_datum = harmParseDate(row.start_datum);
    return {
      id: row.id,
      cislo: row.cislo,
      faza_kod: row.faza_kod,
      podpodfaza: row.podpodfaza,
      projektant: row.projektant,
      poradie: row.poradie,
      trvanie_tyzdne: row.trvanie_tyzdne,
      alokacia_percent: row.alokacia_percent,
      start_datum,
      koniec_datum: start_datum ? logic.harmPridajTyzdne(start_datum, row.trvanie_tyzdne) : null,
      pripravene_pokracovat: !!row.pripravene_pokracovat,
      najskor_od: harmParseDate(row.najskor_od),
      prioritny: !!row.prioritny,
      termin_klient: harmParseDate(row.termin_klient),
      ozvali_sa_datum: harmParseDate(row.ozvali_sa_datum),
      created_at: row.created_at,
      caflou_task_id: row.caflou_task_id,
      poznamka: row.poznamka,
    };
  }

  async function harmFetchAll(sb) {
    const { data, error } = await sb.from('harmonogram').select('*');
    if (error) throw error;
    return data.map(harmRowToLogic);
  }

  // requests z ponuky.html - len pre projekty, ktoré sa reálne plánujú (cisla), aby sa nepýtalo na všetko.
  async function harmFetchRequestsForCisla(sb, cisla) {
    if (!cisla.length) return [];
    const { data, error } = await sb.from('requests')
      .select('id, project_cislo, phases, podklady_datum')
      .in('project_cislo', cisla);
    if (error) throw error;
    return data.map(r => ({
      id: r.id,
      project_cislo: r.project_cislo,
      phases: r.phases || [],
      podklady_datum: harmParseDate(r.podklady_datum),
    }));
  }

  // Naplánuje frontu čisto in-memory (nič nezapisuje) - obal nad harmNaplanujFrontu z harmonogram-logic.js.
  function harmPlan(vsetkyRiadky, dnes, maxPercent) {
    const existujuce = vsetkyRiadky.filter(r => r.start_datum);
    const nenaplanovane = vsetkyRiadky.filter(r => !r.start_datum);
    return logic.harmNaplanujFrontu(nenaplanovane, existujuce, dnes, maxPercent);
  }

  // Zapíše navrhovany_start späť do harmonogram.start_datum - len pre riadky, kde sa našiel termín
  // (pripravene_pokracovat a voľné okno). Nič nezapisuje pre nepripravené/nenájdené (navrhovany_start === null).
  async function harmZapisNaplanovane(sb, naplanovaneVysledky) {
    const naZapis = naplanovaneVysledky.filter(v => v.navrhovany_start);
    await Promise.all(naZapis.map(v =>
      sb.from('harmonogram').update({ start_datum: harmFormatDate(v.navrhovany_start) }).eq('id', v.id)
    ));
    return naZapis.length;
  }

  // Kompletný beh: fetch -> naplánuj nenaplánované -> zapíš im start_datum -> navrhni podklady_datum
  // pre súvisiace ponuky.html requesty. Návrhy podklady_datum sa LEN VRACAJÚ, nezapisujú sa do requests -
  // rozhodnuté (CLAUDE.md): kým nie je UI na manuálne schválenie, prepisovanie by bolo príliš riskantné.
  async function harmSpustiPlanovanie(sb, opts) {
    opts = opts || {};
    const dnes = opts.dnes || new Date();
    const maxPercent = opts.maxPercent || 100;

    const vsetky = await harmFetchAll(sb);
    const vysledky = harmPlan(vsetky, dnes, maxPercent);
    const pocetZapisanych = await harmZapisNaplanovane(sb, vysledky);

    const naplanovaneMapa = new Map(vysledky.map(v => [v.id, v]));
    const kompletne = vsetky.map(r => {
      const v = naplanovaneMapa.get(r.id);
      if (v && v.navrhovany_start) {
        return Object.assign({}, r, { start_datum: v.navrhovany_start, koniec_datum: v.navrhovany_koniec });
      }
      return r;
    });

    const cisla = [...new Set(kompletne.map(r => r.cislo))];
    const requests = await harmFetchRequestsForCisla(sb, cisla);
    const navrhyPodklady = logic.harmNajdiNavrhyPreDopyty(kompletne, requests);

    return { vysledky, pocetZapisanych, navrhyPodklady };
  }

  const api = {
    harmParseDate, harmFormatDate, harmRowToLogic, harmFetchAll, harmFetchRequestsForCisla,
    harmPlan, harmZapisNaplanovane, harmSpustiPlanovanie,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    Object.assign(root, api);
  }
})(typeof window !== 'undefined' ? window : globalThis);
