// Starter templates retired from the New Score wizard on 2026-10-18 ("fewer, better": they opened empty plug-ins and
// overlapped each other). Kept verbatim so any of them can come back: paste the entry into STARTERS in
// web/features/wizard-templates.js, set its category, and harvest its presets (tools/harvest-presets.mjs) so it loads
// ready to play. They use helpers and constants from that file (R, P, bbc, brief, LIBS, KONTAKT, SAC2) and the
// constants below (removed from it with these templates). Not loaded by anything.
  const OPUS = ['Opus'];
  const SINE = ['SINE Player'];
  const TOC = 'The Orchestra Complete 4.nki ›';                // F:\VST\The Orchestra_SonuScore (Kontakt)
  const HFS = 'Hollywood Fantasy Strings ›', HFB = 'Hollywood Fantasy Brass ›', HFW = 'Hollywood Fantasy Winds ›';
  const AK = 'Ancient Kingdom ›', SD3 = 'Stormdrum 3 › SD3 Instruments ›', HC = 'Hollywood Choirs ›';
  const BFO = 'Berlin Free Orchestra ›', ARBOS = 'Arbos ›';
const RETIRED_STARTERS = [
    { id: 'rpg-village', name: 'Cozy RPG village', category: 'Retro & Chiptune',
      note: 'A pixel-art town waltz: Pocket Strings fiddle, accordion, hammered dulcimer and a music box.',
      brief: brief(108, [3, 4], 'G major (Mixolydian colour)', [['Morning', 4], ['Town A', 8], ['Town B', 8], ['Market', 8], ['Loop', 4]],
        'A looping town theme the player hears for hours, so keep it gentle and catchy. The fiddle plays a stepwise tune ' +
        'with one memorable leap; the accordion answers in the gaps. Flatten the 7th (F natural) in Town B for a folk ' +
        'Mixolydian lift. In the Market section the dulcimer plays repeated-note tremolos and the frame drum enters; ' +
        'the music box doubles the last phrase two octaves up as the loop point.'),
      rows: [
        P('Fiddle', 'Village', 'strings', 'violin', ['Pocket Strings', ...KONTAKT], { 'Pocket Strings': 'Pocket Strings → the violin, legato', '*': 'a solo fiddle' }),
        P('Accordion', 'Village', 'world', 'other', KONTAKT, `${SAC2} Organ › "N64 Accordion"`),
        P('Dulcimer', 'Village', 'world', 'other', OPUS, `${HFS} 3 Dulcimers › 01 Long › "3 Dulc Live 04 Sus Trem"`),
        SACROW('Music Box', 'Village', 'keyboards', 'celesta', `${SAC} SNES › Orchestral › "ORCH Music Box"`),
        P('Pizz Bass', 'Village', 'strings', 'doublebass', ['Pocket Strings', ...KONTAKT], { 'Pocket Strings': 'Pocket Strings → the bass, pizzicato', '*': 'a pizzicato bass' }),
        P('Frame Drum', 'Village', 'percussion', 'percussion', ['Hammers'], 'Hammers → "Drums: Frame Drums"'),
      ] },
    { id: 'lofi-study', name: 'Lo-fi study beats', category: 'Lo-fi & Chill',
      note: 'Sonuscore lo ki chords, Felt Piano melody, RA Lofi Drummer and a mellow UJAM bass.',
      brief: brief(78, [4, 4], 'E♭ major (E♭maj9 – Cm11 – A♭maj7 – B♭13sus)', [['Intro', 4], ['Loop A', 8], ['Loop B', 8], ['Break', 4], ['Outro', 4]],
        'Start from a four-chord loop of extended chords voiced in close position on lo ki, then drag everything slightly ' +
        'behind the beat. Felt Piano plays a sparse melody — three or four notes a bar — and leaves bar 4 of every phrase ' +
        'empty to breathe. Loop B keeps the same chords but pedals the bass on A♭: a cheap, very lo-fi trick. Love-Fi ' +
        'answers the melody with tape-warped keys in the Break.'),
      rows: [
        P('lo ki Chords', 'Band', 'keyboards', 'piano', KONTAKT, 'lo ki (F:\\VST\\Sonuscore lo ki) › instrument › "lo ki.nki": pick a band preset and play the chords'),
        P('Felt Piano', 'Band', 'keyboards', 'piano', ['Originals - Felt Piano'], 'Felt Piano → "#3 Half and Half" (or "#2 Up Close")'),
        P('Love-Fi Keys', 'Band', 'keyboards', 'piano', ['Love-Fi 3'], 'Love-Fi 3 → a dusty electric-piano preset; turn up wow & flutter'),
        P('Guitar', 'Band', 'rhythm', 'guitar', ['Solaris GTR'], 'Solaris GTR → a clean jazz-chord preset; answer the piano in bars 2 and 4'),
        P('Bass', 'Band', 'rhythm', 'bassguitar', ['VB-MELLOW'], 'VB-MELLOW → a soft fingered style; play roots, let it phrase'),
        P('Drums', 'Band', 'rhythm', 'percussion', ['RA Lofi Drummer'], 'RA Lofi Drummer → a boom-bap kit, swing ~55%'),
      ] },
    { id: 'cafe-piano', name: 'Background piano café trio', category: 'Lo-fi & Chill',
      note: 'Quiet Piano 2 with a walking upright, Abbey Road brushes and a whisper of strings.',
      brief: brief(84, [4, 4], 'F major', [['Intro', 4], ['A', 16], ['B', 8], ['A', 8], ['Tag', 4]],
        'Music that sits behind conversation: no big climaxes, melody in the middle register (C4–C6), everything mp. ' +
        'Left hand plays tenths on 1 and 3, right hand a melody over a guide-tone line. Reharmonise the last two bars of ' +
        'each A phrase with a ii–V into the next key area. Bass and brushes never change; the only variation is the ' +
        'piano’s density (shell voicings in A, rootless four-note voicings in B). Tag: Mrs Mills, slightly out of tune.'),
      rows: [
        P('Piano', 'Trio', 'keyboards', 'piano', ['Quiet Piano 2'], 'Quiet Piano 2 → a soft upright / felt preset with the room up'),
        P('Upright Bass', 'Trio', 'rhythm', 'doublebass', KONTAKT, 'Session Bassist - Upright Bass › "Upright Bass.nki" › snapshot "Take A Walk" (walks from your chords)'),
        P('Brushes', 'Trio', 'rhythm', 'percussion', KONTAKT, 'Abbey Road 50s Drummer › "AR50s Autumn Kit - Full.nki" › snapshot "Autumn Jazz" (brushes)'),
        P('Strings', '', 'strings', 'violin', ['Originals - Intimate Strings'], 'Intimate Strings → "Strings Long Flautando" (B section only)'),
        P('Tag Piano', '', 'keyboards', 'piano', ['Originals - Mrs Mills Piano'], 'Mrs Mills Piano → "Piano Distant"'),
      ] },
    { id: 'tape-ambient', name: 'Tape & VHS daydream', category: 'Lo-fi & Chill',
      note: 'Wobbly tape synths, VHS keys and QuietMusic dream sounds over a field recording.',
      brief: brief(70, [4, 4], 'A Lydian (A major with D♯)', [['Fade in', 8], ['Drift', 16], ['Bloom', 8], ['Fade out', 8]],
        'No drums: time moves by chord changes every two bars and by tape wobble. Lydian’s raised 4th (D♯) gives a hazy, ' +
        'floating brightness — land on it, don’t resolve it. Write one 4-note motif and give it to three synths at ' +
        'different note values (quarter, dotted quarter, half) so it phases against itself. Drag an ambience from ' +
        'D:\\VST\\Black Octopus (Ambient Field Recordings by AK) onto an audio track underneath.'),
      rows: [
        P('Tape Pad', 'Tape', 'synth', 'synth', ['BlankFor.ms - Tape Synths'], 'Tape Synths → "Magnetic Dreams" (or Pads › "Magnetic Haze")'),
        P('Motif (dotted)', 'Tape', 'synth', 'synth', ['BlankFor.ms - Tape Synths'], 'Tape Synths → "Floating Dots" (or "Bouncing Glows")'),
        P('VHS Keys', 'Tape', 'keyboards', 'synth', ['VHS Dreamwaves'], 'VHS Dreamwaves → an electric-piano / keys preset'),
        P('VHS Strings', 'Tape', 'strings', 'synth', ['VHS Waves'], 'VHS Waves → a string-machine pad'),
        P('Dream Bells', 'Tape', 'synth', 'synth', ['DreamWaves'], 'DreamWaves → a soft bell or pluck for the motif in halves'),
        P('Lo-fi Piano', 'Tape', 'keyboards', 'piano', ['Pure LoFi'], 'Pure LoFi → a cassette-piano preset'),
      ] },
    { id: 'synthwave', name: 'Serum synthwave night drive', category: 'Synth worlds',
      note: 'Serum 2 lead and bass, Jup-8 pads, a Prophet arp and UJAM’s 80s drums.',
      brief: brief(100, [4, 4], 'F♯ minor (i – VI – III – VII)', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Bridge', 4], ['Last chorus', 8], ['Outro', 4]],
        'Outrun: F♯m – D – A – E, gated snare on 2 and 4, octave-bouncing bass in straight 8ths. Serum takes the lead with ' +
        'a long portamento — climb by step into the chorus and leap a 6th at the hook. Jup-8 holds wide voicings ' +
        '(root–5th–10th); the Prophet arpeggiates 16ths an octave above. Bridge: drop the drums, keep the arp and a ' +
        'filter sweep, then hit the last chorus a half-step up in G minor.'),
      rows: [
        P('Lead', 'Synths', 'synth', 'synth', ['Serum 2'], 'Serum 2 → Factory › Lead › "LD - Analog Glow" (or "LD - Sawblade Rush")'),
        P('Pad', 'Synths', 'synth', 'synth', ['Jup-8 V4'], 'Jup-8 V4 → Factory "Miami Vice Strings" (or "Shimmering Pad")'),
        P('Arp', 'Synths', 'synth', 'synth', ['Prophet-5 V'], 'Prophet-5 V → Factory "Seq Me Hard" (or "Chill Keys" with the arp on 16ths)'),
        P('Seq Stabs', 'Synths', 'synth', 'synth', ['Serum 2'], 'Serum 2 → Factory › Seq › "SEQ - Broken 80s Tape"'),
        P('Bass', 'Rhythm', 'rhythm', 'bassguitar', ['Serum 2'], 'Serum 2 → Factory › Bass › "BA - Neon Drive"'),
        P('Drums', 'Rhythm', 'rhythm', 'percussion', ['BM-VICE'], 'BM-VICE → an 80s kit with a gated snare'),
      ] },
    { id: 'synth-orchestra', name: 'Analog synth orchestra', category: 'Synth worlds',
      note: 'Orchestrate a symphony with vintage synths: Solina strings, CS-80 brass, Mellotron winds and choir.',
      brief: brief(72, [4, 4], 'C minor', [['Intro', 4], ['Chorale', 8], ['Development', 8], ['Climax', 8], ['Coda', 4]],
        'Think Vangelis, Wendy Carlos, Tomita. Write a four-part chorale first and assign it exactly as you would for an ' +
        'orchestra: Solina = upper strings, Jup-8 = low strings, CS-80 = brass, Mellotron = oboe and choir, Synclavier = ' +
        'bells, Prophet = basses. In the Climax let the CS-80 brass swell on long notes and bend up a semitone into the ' +
        'downbeat (pitch-bend as the ribbon), with the Modular "timpani" rolling underneath.'),
      rows: [
        P('Strings (Solina)', 'Synth Strings', 'strings', 'violin', ['Solina V2'], 'Solina V2 → Factory "String Ensemble" (or "Ambi Strings 1")'),
        P('Low Strings (Jup-8)', 'Synth Strings', 'strings', 'cello', ['Jup-8 V4'], 'Jup-8 V4 → Factory "Wide Strings"'),
        P('Basses (Prophet)', 'Synth Strings', 'strings', 'doublebass', ['Prophet-5 V'], 'Prophet-5 V → Factory "4th Harmonic Bass"'),
        P('Brass (CS-80)', 'Synth Brass & Winds', 'brass', 'horn', ['CS-80 V4'], 'CS-80 V4 → Factory "Ascendant Brass" (or "Gentle Syn Brass")'),
        P('Oboe (Mellotron)', 'Synth Brass & Winds', 'woodwinds', 'oboe', ['Mellotron V'], 'Mellotron V → Factory "Oboe Solo"'),
        P('Choir (Mellotron)', 'Synth Brass & Winds', 'voices', 'soprano', ['Mellotron V'], 'Mellotron V → Factory "Big Stereo Choir"'),
        P('Bells (Synclavier)', 'Synth Perc', 'percussion', 'glockenspiel', ['Synclavier V'], 'Synclavier V → Factory "Crystal Bells"'),
        P('Timpani (Modular)', 'Synth Perc', 'percussion', 'timpani', ['Modular V3'], 'Modular V3 → Factory "Bass Rumble" (short decay, tuned)'),
      ] },
    { id: 'berlin-school', name: 'Berlin School sequencers', category: 'Synth worlds',
      note: 'Three step sequences of different lengths phasing on one scale, Mellotron flute on top.',
      brief: brief(120, [4, 4], 'A minor (Aeolian)', [['Intro', 8], ['Sequence A', 16], ['Sequence B', 16], ['Outro', 8]],
        'Tangerine Dream and Klaus Schulze: three sequences of 16, 15 and 12 sixteenth-notes on one A-minor scale drift in ' +
        'and out of phase (write each as a looping clip of its own length). Don’t change the notes for long stretches — ' +
        'change filter cutoff and envelope instead (automate them in Bitwig). A slow Mellotron flute melody floats on top. ' +
        'Sequence B: transpose all sequences up a fourth together for 8 bars, then back.'),
      rows: [
        P('Seq 1 (16 steps)', 'Sequencers', 'synth', 'synth', ['Modular V3'], 'Modular V3 → Factory "Berliner"'),
        P('Seq 2 (15 steps)', 'Sequencers', 'synth', 'synth', ['Synthi V'], 'Synthi V → Factory "Layered Seq In C" (or "Jarre Oxygene 2 Seq&Laser")'),
        P('Seq 3 (12 steps)', 'Sequencers', 'synth', 'synth', ['Matrix-12 V2'], 'Matrix-12 V2 → Factory "Mono Seq"'),
        P('Mellotron Flute', 'Lines', 'woodwinds', 'flute', ['Mellotron V'], 'Mellotron V → Factory "Rubycon Part One Flute Ending"'),
        P('String Machine', 'Lines', 'strings', 'synth', ['Solina V2'], 'Solina V2 → Factory "Berlin School"'),
        P('Drone', 'Lines', 'texture', 'synth', ['Pigments'], 'Pigments → a slowly evolving drone (filter the browser by "Drone")'),
      ] },
    { id: 'sonuscore-animated', name: 'The Orchestra: animated fantasy', category: 'Cinematic',
      note: 'Sonuscore’s ensemble engine plays the motion; you write the long lines. Aurora Choir on top.',
      brief: brief(120, [6, 8], 'D major / B minor', [['Intro', 4], ['Theme A', 8], ['Theme B', 8], ['Battle', 8], ['Finale', 4]],
        'Let The Orchestra’s animator do the rhythm and write only whole-bar chords on the Ensemble track; compose the ' +
        'melody on the separate horn and string tracks. Change snapshot (or the KS keyswitch) at each section instead of ' +
        'writing new rhythms. In the Battle switch the Rhythm track to "BATTLE Rhythm 8ths (6-8) 01" and let the low ' +
        'strings play marcato quarters against the 6/8. Aurora sopranos sing "ah" in the Finale only.'),
      rows: [
        P('Ensemble (animated)', 'The Orchestra', 'strings', 'piano', KONTAKT, `${TOC} Snapshots › Animated Orchestra › "Adventurous Steps (6-8) KS"`),
        P('Rhythm Ensemble', 'The Orchestra', 'strings', 'piano', KONTAKT, `${TOC} Snapshots › Orchestral Rhythms › "BATTLE Rhythm 8ths (6-8) 01"`),
        P('Horns', 'Brass', 'brass', 'horn', KONTAKT, 'The Orchestra › Instruments › 02 Brass › 01 French Horns › "05 French Horns Pure Performance Legato.nki"'),
        P('High Strings', 'Strings', 'strings', 'violin', KONTAKT, 'The Orchestra › Instruments › 01 Strings › 01 High Ensemble › "01 High Strings All Articulations.nki"'),
        P('Low Strings', 'Strings', 'strings', 'cello', KONTAKT, 'The Orchestra › Instruments › 01 Strings › 02 Low Ensemble › "04 Low Strings Marcato.nki"'),
        P('Harp', 'Strings', 'keyboards', 'harp', KONTAKT, 'The Orchestra › Instruments › 05 Keys & Harp › "Orchestral Harp.nki"'),
        P('Taikos & Hits', 'Percussion', 'percussion', 'percussion', KONTAKT, 'The Orchestra › Instruments › 04 Percussion › 01 Unpitched › "Taiko Drums.nki"'),
        P('Aurora Sopranos', 'Choir', 'voices', 'soprano', KONTAKT, 'Aurora Choir › AURORA Sopranos › "AURORA Sopranos.nki"'),
      ] },
    { id: 'ew-fantasy', name: 'Hollywood Fantasy quest', category: 'Cinematic',
      note: 'EastWest’s fantasy orchestra: Hardanger fiddles, whistles, ocarinas, alpenhorns and Wagner tubas.',
      brief: brief(92, [4, 4], 'D Dorian', [['Prologue', 4], ['Village', 8], ['Journey', 8], ['Mountain', 8], ['Return', 4]],
        'A Celtic-flavoured quest built from instruments a normal orchestra doesn’t have. Hardanger fiddles carry the tune ' +
        'in D Dorian (the raised 6th, B♮, is the colour), dulcimers tremolo the harmony, the low whistle answers in bars 4 ' +
        'and 8. For the Mountain, three alpenhorns hold an open fifth and the Wagner tubas move in a close chorale below — ' +
        'slow, noble, no percussion. The octave string patches play pulses only in the Journey.'),
      rows: [
        P('Hardanger Fiddles', 'Folk', 'strings', 'violin', OPUS, `${HFS} 3 Hardanger Fiddles › 04 Legato › "3 HdgrFdl Leg Slur"`),
        P('Low Whistle', 'Folk', 'woodwinds', 'flute', OPUS, `${HFW} 2 Irish Whistles Low D › 04 Legato › "2 Irish Whistles LO D Leg Slur"`),
        P('Ocarinas', 'Folk', 'woodwinds', 'flute', OPUS, `${HFW} 4 Ocarinas › 04 Legato › "4 Ocarinas Leg Slur"`),
        P('Dulcimers', 'Folk', 'world', 'other', OPUS, `${HFS} 3 Dulcimers › 01 Long › "3 Dulc Live 04 Sus Trem"`),
        P('Alpenhorns', 'Brass', 'brass', 'horn', OPUS, `${HFB} 3 Alpenhorns › 01 Long › "3 Alp Sus and Drone"`),
        P('Wagner Tubas', 'Brass', 'brass', 'horn', OPUS, `${HFB} 3 Wagner Tubas › 04 Legato › "3 WagTuba Leg Slur"`),
        P('High Strings', 'Strings', 'strings', 'violin', OPUS, `${HFS} 8 Violins and 6 Violas › 04 Legato › "Hi Str Oct Leg Slur"`),
        P('Low Strings', 'Strings', 'strings', 'cello', OPUS, `${HFS} 6 Celli and 4 Basses › 02 Short › "Low Str Oct Spiccato RRx4"`),
        P('Bodhrans', 'Percussion & Voice', 'percussion', 'percussion', OPUS, 'Hollywood Fantasy Percussion › "3 Bodhrans"'),
        P('Solo Voice', 'Percussion & Voice', 'voices', 'soprano', OPUS, 'Hollywood Fantasy Voices › 2 Legato › "Solo Voice Ah Legato" (3 Words for Elvish syllables)'),
      ] },
    { id: 'ew-viking', name: 'Northern saga', category: 'Cinematic',
      note: 'EastWest epic: Voices of Passion, Viking lurs and war horns, Hollywood Choirs and Stormdrum 3.',
      brief: brief(76, [4, 4], 'E minor (bare fifths)', [['Fog', 4], ['Gathering', 8], ['March', 8], ['Battle', 8], ['Pyre', 4]],
        'Raw and pre-orchestral. Fog: a solo Bulgarian voice (Voices of Passion) over a Viking lur drone on E. Gathering: ' +
        'Stormdrum’s Lord of Toms in a 3+3+2 pattern. March: men’s choir on "ah" in parallel fifths (no thirds — keep it ' +
        'ancient) with the low brass doubling. Battle: the women’s choir enters a minor sixth above, war-horn calls every ' +
        'two bars, Dragon ensemble hits on the downbeats. Pyre: back to the bare fifth and the solo voice.'),
      rows: [
        P('Solo Voice', 'Voices', 'voices', 'alto', OPUS, 'Voices of Passion › Bulgaria › "Bulgaria Master"'),
        P('Men’s Choir', 'Voices', 'voices', 'tenor', OPUS, `${HC} Mens Choir › MEN vowels › "MEN Epic ah"`),
        P('Women’s Choir', 'Voices', 'voices', 'soprano', OPUS, `${HC} Womens Choir › WOMEN vowels › "WOMEN Epic ah"`),
        P('Viking Lur', 'Horns', 'brass', 'horn', OPUS, `${AK} Viking Lur › 01 Long › "Viking Lur Bass Sus NV VB MOD"`),
        P('War Horn', 'Horns', 'brass', 'horn', OPUS, `${AK} Viking War Horn › 01 Long › "Viking War Horn Cres"`),
        P('Low Brass', 'Horns', 'brass', 'tuba', OPUS, `${HFB} 6 Low Brass Ensemble › 01 Long › "6 LowBrass Sus Full"`),
        P('Toms', 'Drums', 'percussion', 'percussion', OPUS, `${SD3} A Quickstart Folder › "Lord of Toms Ensemble"`),
        P('Dragon Hits', 'Drums', 'percussion', 'percussion', OPUS, `${SD3} Big Drums › "Dragon Ens Hits 1 fullmix"`),
        P('Frame Drum', 'Drums', 'percussion', 'percussion', OPUS, `${SD3} Big Drums › "Frame Drum 22in Renaissance"`),
      ] },
    { id: 'abbey-road-film', name: 'Abbey Road main title', category: 'Cinematic',
      note: 'Spitfire’s Abbey Road One + Two and the Orchestral Grand: a lyrical film theme in Studio One.',
      brief: brief(66, [4, 4], 'D♭ major', [['Opening', 4], ['Theme', 8], ['Theme (tutti)', 8], ['Bridge', 4], ['Final statement', 8]],
        'A lyrical main title in the Williams / Thomas Newman lineage. State the theme on solo piano, then on the horns in ' +
        'unison, then on violins 1 in octaves with the violas, celli on the bass line. The Legendary Low Strings hold long ' +
        'pedals; the Sparkling Woodwinds do the decorative runs in the Bridge. Before the final cadence put a Grand Brass ' +
        'chord on IV (G♭) — and let the piano have the last word, alone.'),
      rows: [
        P('Piano', '', 'keyboards', 'piano', KONTAKT, 'Spitfire Orchestral Grand (C:\\Spitfire\\Spitfire Orchestral Grand library) › "Spitfire Orchestral Grand.nki"'),
        P('Flutes', 'Woodwinds', 'woodwinds', 'flute', ['Abbey Road One'], 'Abbey Road One → "Wondrous Flutes"'),
        P('Woodwinds', 'Woodwinds', 'woodwinds', 'clarinet', ['Abbey Road One'], 'Abbey Road One → "Sparkling Woodwinds"'),
        P('Horns', 'Brass', 'brass', 'horn', ['Abbey Road One'], 'Abbey Road One → "Thematic Horns"'),
        P('Grand Brass', 'Brass', 'brass', 'trombone', ['Abbey Road One'], 'Abbey Road One → "Grand Brass"'),
        P('Violins 1', 'Strings', 'strings', 'violin', ['Abbey Road Two'], 'Abbey Road Two → Iconic Strings › "Violin 1 Legato" (or "Live Patch")'),
        P('Violins 2', 'Strings', 'strings', 'violin', ['Abbey Road Two'], 'Abbey Road Two → Iconic Strings › "Violin 2 Long"'),
        P('Violas', 'Strings', 'strings', 'viola', ['Abbey Road Two'], 'Abbey Road Two → Iconic Strings › "Viola Legato"'),
        P('Celli', 'Strings', 'strings', 'cello', ['Abbey Road Two'], 'Abbey Road Two → Iconic Strings › "Cello Legato"'),
        P('Low Strings', 'Strings', 'strings', 'doublebass', ['Abbey Road One'], 'Abbey Road One → "Legendary Low Strings"'),
      ] },
    { id: 'minimalist', name: 'Minimalist machine (Glass / Reich)', category: 'Hybrid',
      note: 'Process music with Cimbalom, Symphonic Motions, Fractured Strings, Albion ONE and Hammers.',
      brief: brief(132, [4, 4], 'A minor → F major', [['Phase 1', 8], ['Phase 2', 8], ['Phase 3', 8], ['Phase 4', 8], ['Coda', 4]],
        'Pick one 8-note pattern (A–C–E–G–F–E–C–B) and never change it — only add, remove and shift. Phase 1: cimbalom ' +
        'alone. Phase 2: Symphonic Motions plays the same pattern displaced by one 8th. Phase 3: Hammers adds a 3+3+2 ' +
        'pulse and Fractured Strings "Statements" punctuate every four bars. Phase 4: the bass moves down a third to F ' +
        'under the same pattern — the Glass modulation. Coda: remove one layer per bar.'),
      rows: [
        P('Cimbalom', 'Pattern', 'world', 'other', ['Originals - Cimbalom'], 'Cimbalom → "Cimbalom Damped"'),
        P('Felt Piano', 'Pattern', 'keyboards', 'piano', ['Originals - Felt Piano'], 'Felt Piano → "#6 Short Space"'),
        P('Motions', 'Strings', 'strings', 'violin', ['Symphonic Motions'], 'Symphonic Motions → "Pulsing Con Sord" (or "Engine Room Pulses")'),
        P('Fractured Strings', 'Strings', 'strings', 'cello', ['Fractured Strings'], 'Fractured Strings → Standard › "Celli Statements Up" (and "Violins Statements Up")'),
        P('Albion ONE', 'Strings', 'strings', 'violin', KONTAKT, 'Albion ONE (C:\\Spitfire\\Spitfire Albion ONE library) › Instruments › Albion One Orchestra › "Strings.nki"'),
        P('Hammers', 'Pulse', 'percussion', 'percussion', ['Hammers'], 'Hammers → "Drums: Frame Drums" (Loops › "Frame Drums" for a ready groove)'),
      ] },
    { id: 'spitfire-intimate', name: 'Home-recorded indie film', category: 'Chamber & intimate',
      note: 'Close and small: Fink’s guitars and voice, Felt Piano, Intimate Strings and a Rare Flutes ocarina.',
      brief: brief(72, [4, 4], 'G major', [['Intro', 4], ['Verse', 8], ['Chorus', 8], ['Interlude', 4], ['Chorus', 8]],
        'As if tracked in someone’s living room. Fink’s "Orwell" guitar picks the harmony in thirds; Felt Piano doubles ' +
        'only the guitar’s top note. Intimate Strings stay on long notes (flautando in the verse, normal in the chorus), ' +
        'never more than three at a time. The ocarina plays the hook once per chorus. In the last chorus Fink’s "Ooh ' +
        'Swell" voice doubles the strings’ top line an octave down.'),
      rows: [
        P('Guitar', 'Band', 'rhythm', 'guitar', ['Fink - Signatures'], 'Fink - Signatures → Orwell › "Plucked Notes" (or "Two Finger Chords")'),
        P('Felt Piano', 'Band', 'keyboards', 'piano', ['Originals - Felt Piano'], 'Felt Piano → "#2 Up Close"'),
        P('Stomps & Cases', 'Band', 'percussion', 'percussion', ['Fink - Signatures'], 'Fink - Signatures → Percussion › "Stomps and Cases"'),
        P('Strings', 'Strings', 'strings', 'violin', ['Originals - Intimate Strings'], 'Intimate Strings → "Strings Long Flautando" (chorus: "Strings Long")'),
        P('Pizzicato', 'Strings', 'strings', 'cello', ['Originals - Intimate Strings'], 'Intimate Strings → "Strings Pizzicato"'),
        P('Ocarina', 'Colour', 'woodwinds', 'flute', ['Originals - Rare Flutes'], 'Rare Flutes → "Flute Long Ocarina Mid"'),
        P('Voice', 'Colour', 'voices', 'alto', ['Fink - Signatures'], 'Fink - Signatures → Voice › "Ooh Swell"'),
      ] },
    { id: 'bfo-pastoral', name: 'Berlin Free Orchestra pastoral', category: 'Chamber & intimate',
      note: 'Orchestral Tools’ free orchestra in SINE: solo winds trading a theme in 6/8, a storm and a horn chorale.',
      brief: brief(138, [6, 8], 'F major', [['Dawn', 4], ['Theme', 8], ['Variation', 8], ['Storm', 8], ['Thanksgiving', 8]],
        'Write like a Pixar woodwind section: flute and clarinet trade the theme in two-bar phrases, the oboe takes a ' +
        'plaintive variation in D minor, the bassoon gets the comic staccato bass line. Strings only pad and pizz. Storm: ' +
        'timpani rolls, string tremolo, stopped-horn calls. Thanksgiving: a solo horn chorale over sustained strings with ' +
        'harp arpeggios. Mind the real ranges: these are recorded players.'),
      rows: [
        P('Flute', 'Woodwinds', 'woodwinds', 'flute', SINE, `${BFO} Solo Flute`),
        P('Oboe', 'Woodwinds', 'woodwinds', 'oboe', SINE, `${BFO} Solo Oboe`),
        P('Clarinet', 'Woodwinds', 'woodwinds', 'clarinet', SINE, `${BFO} Solo Clarinet`),
        P('Bassoon', 'Woodwinds', 'woodwinds', 'bassoon', SINE, `${BFO} Solo Bassoon`),
        P('Horn', 'Brass', 'brass', 'horn', SINE, `${BFO} Solo French Horn`),
        P('Timpani', 'Percussion', 'percussion', 'timpani', SINE, `${BFO} Timpani`),
        P('Glockenspiel', 'Percussion', 'percussion', 'glockenspiel', SINE, `${BFO} Glockenspiel`),
        P('Harp', 'Harp', 'keyboards', 'harp', SINE, `${BFO} Harp`),
        P('Strings', 'Strings', 'strings', 'violin', SINE, `${BFO} String Ensemble (or Violins a8 / Violas a5 / Celli a5 / Basses a4)`),
      ] },
    { id: 'cathedral', name: 'Cathedral at dusk: choir & organ', category: 'Chamber & intimate',
      note: 'Eric Whitacre Choir clusters, Aurora descant, Spitfire Symphonic Organ and the Tallinn choir in SINE.',
      brief: brief(54, [4, 4], 'D major (with added-note clusters)', [['Intonation', 4], ['Verse', 8], ['Cluster', 8], ['Organ', 8], ['Amen', 4]],
        'Whitacre’s signature: begin on a plain D major chord, then let single voices step to added 2nds and 9ths until ' +
        'the choir holds a cluster (D–E–F♯–A–B); resolve it one voice at a time. "Long Mmm" for the verse, "Long Aah" ' +
        'for the cluster. The organ enters only in the Organ section, full pedal, with the Tallinn choir doubling the tune ' +
        'in octaves. The Amen returns to a cappella, very slowly.'),
      rows: [
        P('Sopranos', 'Choir', 'voices', 'soprano', ['Eric Whitacre Choir'], 'Eric Whitacre Choir → Soprano › "Long Mmm" / "Long Aah"'),
        P('Altos', 'Choir', 'voices', 'alto', ['Eric Whitacre Choir'], 'Eric Whitacre Choir → Alto › "Long Mmm" / "Long Aah"'),
        P('Tenors', 'Choir', 'voices', 'tenor', ['Eric Whitacre Choir'], 'Eric Whitacre Choir → Tenor › "Long Mmm" / "Long Aah"'),
        P('Basses', 'Choir', 'voices', 'bass-voice', ['Eric Whitacre Choir'], 'Eric Whitacre Choir → Bass › "Long Mmm" / "Long Aah"'),
        P('Descant (Aurora)', 'Choir', 'voices', 'soprano', KONTAKT, 'Aurora Choir › AURORA Sopranos › "AURORA Sopranos.nki"'),
        P('Tallinn Choir', '', 'voices', 'alto', SINE, 'Tallinn › Female Choir (and Male Choir)'),
        P('Organ', '', 'keyboards', 'organ', KONTAKT, 'Spitfire Symphonic Organ (F:\\VST\\Spitfire\\Spitfire Audio - Symphonic Organ) › "Symphonic Organ.nki"'),
      ] },
    { id: 'gamelan', name: 'Gamelan & hammered metals', category: 'World & texture',
      note: 'Balinese and Javanese gamelan, yangqin, cimbalom and thumb piano in interlocking kotekan.',
      brief: brief(96, [4, 4], 'pelog-like set: E – F – G – B – C', [['Gong cycle', 8], ['Kotekan', 8], ['Slow', 8], ['Kotekan', 8], ['Gong', 4]],
        'Gamelan thinks in cycles, not phrases: write a 16-beat core melody (balungan) on the saron and mark the end of ' +
        'each cycle with the big gong. Then kotekan: split one fast 16th-note figure between two instruments that ' +
        'interlock (polos on the beats, sangsih off the beats) — here gangsa against yangqin. Stay on E–F–G–B–C. ' +
        'Balinese Gamelan’s "Original Pitch" folder keeps the real tuning (beating ombak) if you dare.'),
      rows: [
        P('Gangsa (polos)', 'Gamelan', 'world', 'other', KONTAKT, 'Balinese Gamelan › Instruments › Concert Pitch › "CP Gangsa.nki"'),
        P('Yangqin (sangsih)', 'Gamelan', 'world', 'other', KONTAKT, 'Yangqin › "Yangqin Default.nki"'),
        P('Saron (balungan)', 'Gamelan', 'world', 'other', KONTAKT, 'Javanese Gamelan (D:\\VST\\Javanese Gamelan) › Individual › "Saron.nki"'),
        P('Kettle Gongs', 'Gamelan', 'world', 'other', KONTAKT, 'Balinese Gamelan › Concert Pitch › "CP Kettle Gongs.nki"'),
        P('Gongs', 'Gamelan', 'percussion', 'percussion', KONTAKT, 'Javanese Gamelan › Individual › "Gongs.nki"'),
        P('Cimbalom', 'Colour', 'world', 'other', ['Originals - Cimbalom'], 'Cimbalom → "Cimbalom Tremolo"'),
        P('Thumb Piano', 'Colour', 'world', 'other', KONTAKT, 'Thumb Piano › "Thumb Piano.nki"'),
      ] },
    { id: 'forest-folk', name: 'Forest folk dance in 7/8', category: 'World & texture',
      note: 'Arbos forest percussion (SINE), Irish Harp, Ronroco, bansuri, fujara and hurdy-gurdy.',
      brief: brief(132, [7, 8], 'A Mixolydian', [['Forest floor', 4], ['Dance', 8], ['Clearing', 8], ['Dance', 8], ['Dusk', 4]],
        'A woodland dance in 7/8 grouped 2+2+3 — lean on the long group. All percussion is real forest: Arbos root ' +
        'marimba plays the bass ostinato, the forest drum kit grooves, the pine-cone rainmaker covers transitions. Irish ' +
        'harp and ronroco strum drone-heavy harmony (A, D, G — Mixolydian’s G♮); the bansuri carries the tune and the ' +
        'fujara answers with breathy low calls in the Clearing, over a hurdy-gurdy drone.'),
      rows: [
        P('Bansuri', 'Winds', 'woodwinds', 'flute', ['Originals - Rare Flutes'], 'Rare Flutes → "Flute Long Bansuri" (and "Flute Short Bansuri")'),
        P('Fujara', 'Winds', 'woodwinds', 'bassflute', OPUS, `${AK} _QUICKSTART › "Fujara Large Exp 2"`),
        P('Irish Harp', 'Strings', 'world', 'harp', KONTAKT, 'Irish Harp › "Irish Harp.nki" › snapshot "Irish Harp - Thirty Birds" (or "[White Keys]")'),
        P('Ronroco', 'Strings', 'world', 'guitar', KONTAKT, 'The Ronroco (F:\\Native Instruments\\The Ronroco 1.1.3) › "The Ronroco.nki"'),
        P('Hurdy-Gurdy', 'Strings', 'world', 'other', OPUS, `${HFS} _QUICKSTART › "HurGur 1 Sus Complete MOD VB"`),
        P('Root Marimba', 'Forest', 'percussion', 'marimba', SINE, `${ARBOS} Root marimba low (and high)`),
        P('Forest Drums', 'Forest', 'percussion', 'percussion', SINE, `${ARBOS} Forest drum kit`),
        P('Rainmaker', 'Forest', 'percussion', 'percussion', SINE, `${ARBOS} Pine cone rainmaker falls`),
      ] },
    { id: 'toy-shop', name: 'Toy shop at midnight', category: 'World & texture',
      note: 'A clockwork waltz: Music Box, Toy Piano, Kinetic Toys, Celestatone and Glaze 2.',
      brief: brief(100, [3, 4], 'E minor / G major', [['Wind-up', 4], ['Waltz', 8], ['Mechanism', 8], ['Waltz', 8], ['Unwinding', 4]],
        'A slightly sinister clockwork waltz (Elfman meets Tiersen). Music box plays the tune in thirds at the top; toy ' +
        'piano plays oom-pah-pah. In Mechanism the cuckoo clock and wood blocks become gears in 3-against-2 against the ' +
        'waltz. Unwinding: write longer and longer note values (a written-out ritardando) and let the music box drop notes ' +
        'until a single one is left, out of time.'),
      rows: [
        P('Music Box', 'Toys', 'keyboards', 'celesta', KONTAKT, 'Music Box › "Music Box.nki"'),
        P('Toy Piano', 'Toys', 'keyboards', 'piano', KONTAKT, 'Toy Piano › "Toy Piano.nki"'),
        P('Celestatone', 'Toys', 'keyboards', 'celesta', ['Vaults'], 'Crow Hill Vaults → "CELESTATONE"'),
        P('Melodica', 'Toys', 'woodwinds', 'other', KONTAKT, 'Kinetic Toys › "Melodica.nki"'),
        P('Cuckoo Clock', 'Gears', 'percussion', 'percussion', KONTAKT, 'Kinetic Toys › "Cuckoo Clock.nki" (or "Automaton.nki")'),
        P('Wood Blocks', 'Gears', 'percussion', 'percussion', KONTAKT, 'Kinetic Toys › "Wood Blocks.nki"'),
        P('Glaze Keys', 'Gears', 'synth', 'synth', KONTAKT, 'Glaze 2 › "Glaze 2.nki" › snapshot Keys › "Home Alone"'),
      ] },
    { id: 'ujam-band', name: 'UJAM band in a box', category: 'Pop & groove',
      note: 'Write a lead sheet; UJAM’s virtual drummer, bassist, guitarist, pianist and section players perform it.',
      brief: brief(116, [4, 4], 'A major', [['Intro', 4], ['Verse', 8], ['Pre-chorus', 4], ['Chorus', 8], ['Bridge', 4], ['Chorus', 8]],
        'UJAM players perform a style from the keys you hold: sketch the song as a lead sheet first (melody + chord ' +
        'symbols), then give each player only chord roots or triads and switch styles with the phrase keys at section ' +
        'changes. SE-STRIIIINGS builds the pre-chorus (one sustained chord, crescendo with the mod wheel), SE-BRAAASS ' +
        'stabs the chorus off-beats, and BEAUTYFLUTE plays a counter-melody in the bridge only.'),
      rows: [
        P('Drums', 'Rhythm', 'rhythm', 'percussion', ['VD-SOLID'], 'VD-SOLID → a pop/rock style; phrase keys switch verse and chorus patterns'),
        P('Bass', 'Rhythm', 'rhythm', 'bassguitar', ['VB-ROYAL'], 'VB-ROYAL → a Motown-style pop preset'),
        P('Guitar', 'Rhythm', 'rhythm', 'guitar', ['VG-SPARKLE2'], 'VG-SPARKLE2 → a clean strummed style (Silence key in the verse)'),
        P('Piano', 'Rhythm', 'keyboards', 'piano', ['Virtual Pianist'], 'Virtual Pianist → a pop-ballad pulse style'),
        P('Strings', 'Sections', 'strings', 'violin', ['SE-STRIIIINGS'], 'SE-STRIIIINGS → long legato; mod wheel for the swell'),
        P('Brass', 'Sections', 'brass', 'trumpet', ['SE-BRAAASS'], 'SE-BRAAASS → short stabs'),
        P('Flute', 'Sections', 'woodwinds', 'flute', ['BEAUTYFLUTE Pro'], 'BEAUTYFLUTE Pro → a breathy solo preset'),
        P('Synth', 'Sections', 'synth', 'synth', ['USYNTH'], 'USYNTH → a pluck from one of your USYNTH packs (Caramel, Glam, Euphoria…)'),
      ] },
];
