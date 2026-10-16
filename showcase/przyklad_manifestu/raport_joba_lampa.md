# Reel job batch-B075X2FZSM-4d49542ee7

Wall time 653.9 s · API cost $0.0000 · Google AI not configured (local fallbacks)
Bottleneck: **blender** 528.8 s (81 % of stage time)

## Unit economics

- reels delivered: 6 · API $0.0000 · host 10.9 min ≈ $0.0272
- total $0.0272 → **$0.0045 per reel**
- payback: pass --commission-rate or --commission-usd to estimate break-even sales

| Variant | Locale | Platform | Duration | QA | Passed | Master reused | Marginal API cost | Marginal time | Director | Music | Voice | Video |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | pl-PL | tiktok | 12.0 s | 100 | yes | no | $0.0000 | 18.7 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-pl-PL.mp4 |
| A | pl-PL | instagram_reels | 12.0 s | 97 | yes | yes | $0.0000 | 16.4 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-pl-PL-instagram_reels.mp4 |
| A | en-US | tiktok | 12.0 s | 100 | yes | yes | $0.0000 | 18.2 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-en-US.mp4 |
| A | en-US | instagram_reels | 12.0 s | 100 | yes | yes | $0.0000 | 15.6 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-en-US-instagram_reels.mp4 |
| A | de-DE | tiktok | 12.0 s | 100 | yes | yes | $0.0000 | 19.1 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-de-DE.mp4 |
| A | de-DE | instagram_reels | 12.0 s | 97 | yes | yes | $0.0000 | 15.6 s | template | local-synth | piper | batch-B075X2FZSM-4d49542ee7-A-de-DE-instagram_reels.mp4 |

## Stage timings

- blender: 528.8 s
- ffmpeg_localized: 66.3 s
- qa: 35.5 s
- ffmpeg_master: 17.7 s
- voice: 1.7 s
- sfx: 0.2 s
- analysis: 0.1 s
- director: 0.1 s
- transcreation: 0.0 s
- retrieval: 0.0 s
- music: 0.0 s

## Fallbacks

- music: music-library → local-synth (music-library: music library is empty)

## QA issues

- A pl-PL tiktok: none
- A pl-PL instagram_reels minor text_over_product: overlay.sh04.led_bulb_included covers 3 % of the product (39 % of its panel)
- A en-US tiktok: none
- A en-US instagram_reels: none
- A de-DE tiktok: none
- A de-DE instagram_reels minor text_over_product: overlay.sh04.led_bulb_included covers 4 % of the product (39 % of its panel)
