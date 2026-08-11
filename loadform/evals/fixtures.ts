/**
 * Extraction eval fixtures.
 *
 * These are written to look like what Deepgram actually emits from a broker
 * call, not like clean prose. That means: filler words, mid-sentence
 * self-corrections, jargon, both parties talking, and ASR mistakes. A model
 * that scores well on tidy paragraphs and badly on these will look fine in
 * testing and fail in production.
 *
 * `expect` values are arrays of accepted regexes — free-text fields have many
 * correct spellings ("Amarillo, TX" / "Amarillo Texas"), so exact-match scoring
 * would punish right answers. `null` means the field MUST come back empty:
 * inventing a value is worse than admitting ignorance, because a dispatcher
 * will paste it straight to a driver.
 */

export type Fixture = {
  name: string;
  why: string;
  transcript: string;
  expect: Record<string, RegExp[] | null>;
};

export const FIXTURES: Fixture[] = [
  {
    name: 'clean_reefer',
    why: 'Baseline. Every field stated plainly. A model that fails here fails everything.',
    transcript: `Hey, this is Mike over at TQL, how you doing today? Good, good. So I got a reefer load I'm trying to cover. It picks up in Amarillo, Texas tomorrow morning, that's Tuesday the 24th, 8 AM appointment. Delivers to Tulsa, Oklahoma Thursday the 26th by 6 AM. It's frozen chicken, 43,000 pounds. I can pay 2,100 all in on that one. It's a live load at the shipper, and it's a drop and hook at the receiver. Oh, and heads up, there's a lumper at delivery, runs about 150 bucks, we'll cover that with a T-check. Reefer needs to be set at negative 10 continuous.`,
    expect: {
      pickup_location: [/amarillo/i],
      pickup_datetime: [/8\s*:?0?0?\s*a\.?m/i, /tuesday/i, /24/],
      pickup_type: [/live\s*load/i],
      delivery_location: [/tulsa/i],
      delivery_datetime: [/6\s*:?0?0?\s*a\.?m/i, /thursday/i, /26/],
      delivery_type: [/drop\s*(and|&|\+)?\s*hook/i],
      commodity: [/chicken/i],
      equipment_type: [/reefer|refrigerat/i],
      rate: [/2,?100/],
      weight: [/43,?000/],
      additional_notes: [/lumper|t-?check|negative\s*10|-\s*10/i],
      stops: [/none|direct|^$/i],
    },
  },

  {
    name: 'partial_midcall',
    why:
      'The app auto-extracts DURING the call, so most real prompts are partial. ' +
      'Delivery details do not exist yet — the model must leave them empty rather ' +
      'than hallucinate a destination.',
    transcript: `Yeah so what do you got? I got one picking up in Laredo, Texas. Uh, Friday morning, it's a first come first served, 7 AM to 2 PM. Dry van, 38,000 pounds of canned goods. Let me pull up the delivery info, hang on one second.`,
    expect: {
      pickup_location: [/laredo/i],
      pickup_datetime: [/friday/i],
      pickup_window: [/fcfs|first come/i, /7\s*a\.?m/i],
      commodity: [/canned|can goods|groceries/i],
      equipment_type: [/dry\s*van|van/i],
      weight: [/38,?000/],
      // Must NOT be invented — nothing about delivery was said.
      delivery_location: null,
      delivery_datetime: null,
      rate: null,
    },
  },

  {
    name: 'messy_asr_and_corrections',
    why:
      'Real Deepgram output. "reefer" mis-transcribed as "refer", a corrected day, ' +
      'a corrected rate, spelled-out numbers, and cross-talk.',
    transcript: `Alright so this one picks up Wednesday— no sorry, Thursday. Thursday morning out of Fort Wayne Indiana. Um it's a refer load, keep it at thirty four degrees. Going to Grand Rapids Michigan, needs to be there Friday by noon. Uh what's it paying? I can do eighteen fifty. Eighteen fifty? Yeah. Hmm. Okay let me— actually you know what, I can stretch to nineteen hundred if he can be there early. Nineteen hundred works. Cool. It's uh forty one thousand pounds of produce. Live load both ends. Driver needs a pallet jack at the receiver.`,
    expect: {
      pickup_location: [/fort wayne/i],
      pickup_datetime: [/thursday/i],
      pickup_type: [/live\s*load/i],
      delivery_location: [/grand rapids/i],
      delivery_datetime: [/friday/i, /noon|12/i],
      delivery_type: [/live\s*unload|live/i],
      commodity: [/produce/i],
      // Must resolve the mis-transcription "refer" -> reefer via the 34° context.
      equipment_type: [/reefer|refrigerat/i],
      // Must take the CORRECTED rate, not the first one offered.
      rate: [/1,?900|nineteen hundred/i],
      weight: [/41,?000/],
      additional_notes: [/pallet jack|34|thirty four/i],
    },
  },

  {
    name: 'two_loads_one_taken',
    why:
      'Brokers pitch multiple loads on one call. The dispatcher takes the SECOND. ' +
      'Mixing details across the two is the single most damaging failure mode — ' +
      'it produces a confident, plausible, wrong load sheet.',
    transcript: `I got two right now. First one is Dallas to Memphis, dry van, 2,400, picks up Monday. The other one is a flatbed out of Birmingham Alabama going to Nashville Tennessee, that's picking up Tuesday the 3rd at 10 AM, delivering Wednesday the 4th, appointment at 1 PM. Steel coils, 47,000 pounds, paying 1,750. Yeah the Dallas one won't work for me, my guy's already north. Let's do the Birmingham one. Perfect. It's tarped, you'll need four straps minimum. Empty in, live load.`,
    expect: {
      pickup_location: [/birmingham/i],
      pickup_datetime: [/tuesday/i, /10\s*a\.?m/i, /3rd|3/],
      pickup_type: [/empty in|live\s*load/i],
      delivery_location: [/nashville/i],
      delivery_datetime: [/wednesday/i, /1\s*p\.?m/i, /4th|4/],
      delivery_window: [/appointment|1\s*p\.?m/i],
      commodity: [/steel|coil/i],
      equipment_type: [/flat\s*bed/i],
      rate: [/1,?750/],
      weight: [/47,?000/],
      additional_notes: [/tarp|strap/i],
    },
  },

  {
    name: 'multistop_per_mile',
    why:
      'Rate quoted per mile rather than flat, plus an intermediate stop. Tests the ' +
      'stops field and that a $/mile rate is not silently converted to a total.',
    transcript: `Okay so this is a multi-stop. Picks up in Ontario, California Monday 6 AM, first come first served until 3. Then there's a drop in Phoenix, Arizona on the way, and final delivery is El Paso Texas Tuesday night, they're open 24/7. Dry van, retail goods, about 22,000 pounds total. I'm paying 2 dollars 80 a mile, comes out to around 2,900. Hook a preloaded trailer at the shipper, then it's drop and hook at the final.`,
    expect: {
      pickup_location: [/ontario/i],
      pickup_datetime: [/monday/i, /6\s*a\.?m/i],
      pickup_window: [/fcfs|first come|3/i],
      pickup_type: [/preload|hook/i],
      delivery_location: [/el paso/i],
      delivery_datetime: [/tuesday/i],
      delivery_window: [/24\s*\/?\s*7/i],
      delivery_type: [/drop\s*(and|&|\+)?\s*hook/i],
      stops: [/phoenix/i],
      commodity: [/retail/i],
      equipment_type: [/dry\s*van|van/i],
      rate: [/2\.80|2,?900/],
      weight: [/22,?000/],
    },
  },
];
