# Changelog

## [1.13.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.12.0...baby-log-v1.13.0) (2026-07-02)


### Features

* log medication entries from the journal ([98a3f67](https://github.com/supercairos/baby-log/commit/98a3f67620958aa543b07b256d1c75a5cff5a8e4))
* log medication entries from the journal ([8b473f6](https://github.com/supercairos/baby-log/commit/8b473f6741a53fe2f9d5935d7cf1966fc59b59ee))
* repeat-last-dose chips and a double-dose guard for medication ([45077bf](https://github.com/supercairos/baby-log/commit/45077bfc5ca0085382213f8111202c761ad94f3b))
* repeat-last-dose chips and a double-dose guard for medication ([a9c03ba](https://github.com/supercairos/baby-log/commit/a9c03ba136def05aeed36cabf87c82960e8b50dc))


### Bug Fixes

* show medication in day/week calendar views ([0c844c1](https://github.com/supercairos/baby-log/commit/0c844c16004497beeff5b1c3890225ff956e632e))

## [1.12.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.11.0...baby-log-v1.12.0) (2026-06-29)


### Features

* live timeline refresh with new-entries pill and freshness line ([9ae3b9b](https://github.com/supercairos/baby-log/commit/9ae3b9bdba8968a1a7a0a976e367e2914e3841fb))

## [1.11.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.10.0...baby-log-v1.11.0) (2026-06-10)


### Features

* bottle amounts, breast-side toggles, night recap and nap alerts ([5035d07](https://github.com/supercairos/baby-log/commit/5035d07b86a338079a32bc4aa005fea9b7d8495d))
* discard running timers and a visible stale-timer nudge ([2be08f2](https://github.com/supercairos/baby-log/commit/2be08f2c141c1c3c683321063713d64689c91fe7))
* journal polish — week deltas, predicted-sleep arc, themed dial details ([665c367](https://github.com/supercairos/baby-log/commit/665c3674c16086c9f6e30af178597d3bf833ce16))
* sleep-duration prediction and last-night derivation ([fee1035](https://github.com/supercairos/baby-log/commit/fee103556ff29892667e20192f5b14b5053747ef))
* surface amounts and notes in the timeline list ([441eae2](https://github.com/supercairos/baby-log/commit/441eae23b9557c9e163604074b3eca9f8feb5c8f))


### Bug Fixes

* keep bottle amount on notification-stop; DST-safe calendar math ([ec2e3d2](https://github.com/supercairos/baby-log/commit/ec2e3d25a1688e10020f17a20e000c2e570dea4d))

## [1.10.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.9.0...baby-log-v1.10.0) (2026-06-10)


### Features

* calendar views (day/week/list/summary) for the journal ([4d34bb7](https://github.com/supercairos/baby-log/commit/4d34bb7056802061ca3ebe4f5e8fabfa181b5f74))
* radial 24-h day clock for the journal's Day view ([fb1169c](https://github.com/supercairos/baby-log/commit/fb1169c1d0fa89f2e0242f3dd34763f41830e2e8))
* start & end side by side in the add/edit entry sheet ([3170208](https://github.com/supercairos/baby-log/commit/31702089d1e526d51d160f7f23113760fa0c6f96))
* sunrise/sunset times (suncalc) and a one-shot geolocation hook ([18e844c](https://github.com/supercairos/baby-log/commit/18e844c40f66d3e3541985186da3bf3c4c12499f))

## [1.9.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.8.0...baby-log-v1.9.0) (2026-06-09)


### Features

* add a notes field to the add/edit entry sheet ([b597b3b](https://github.com/supercairos/baby-log/commit/b597b3b87927b5e776527f3ec97f9f6e4ff12051))
* predict next feed, nap & diaper from recent activity ([feb8167](https://github.com/supercairos/baby-log/commit/feb8167bd339c46015d2d05c6970dc5f30e02bda))
* tummy-time goal, child age, and research-backed prediction refinements ([0af8311](https://github.com/supercairos/baby-log/commit/0af83110af955f2c3b263e68724be70411901fcb))


### Bug Fixes

* align tummy-time daily goals with Huckleberry's age chart ([bad4be1](https://github.com/supercairos/baby-log/commit/bad4be1fe2b59435a0b87078b6a771a371e2f676))

## [1.8.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.7.0...baby-log-v1.8.0) (2026-06-05)


### Features

* show a stop icon on the running-timer card instead of text ([03d7459](https://github.com/supercairos/baby-log/commit/03d7459d1ffdab76cc8773193be00641a9fed82b))
* translate the UI with i18next (English, French, Spanish, German, Italian) ([cd0853f](https://github.com/supercairos/baby-log/commit/cd0853f48c825b4467a082a2bfa4ec0740684793))


### Bug Fixes

* drop the redundant "tap Stop to log" from the notification body ([fa9ea99](https://github.com/supercairos/baby-log/commit/fa9ea99505d69a6af2707735b688678117d63068))

## [1.7.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.6.0...baby-log-v1.7.0) (2026-06-05)


### Features

* show the child's name in the timer notification ([e79f96f](https://github.com/supercairos/baby-log/commit/e79f96f5fa107c89480654f1e6197b0551992e40))


### Bug Fixes

* drop permanently-failed writes instead of keeping dead outbox entries ([5887bd1](https://github.com/supercairos/baby-log/commit/5887bd127b9c04c09e12ecd581c3d259685a98f6))
* give the timer notification a per-activity large icon ([7ff20d7](https://github.com/supercairos/baby-log/commit/7ff20d76123d33977c83869ae77ccd27916cf9d6))

## [1.6.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.5.1...baby-log-v1.6.0) (2026-06-05)


### Features

* keep the running-timer notification sticky (re-show if dismissed) ([a0d62c4](https://github.com/supercairos/baby-log/commit/a0d62c41b76187d570ecd0f4745965eb1ebf19ac))


### Bug Fixes

* don't let dead (failed) stop mutations hide a running timer ([ff9cf72](https://github.com/supercairos/baby-log/commit/ff9cf7297bcfcab3f2371f0bed2c63ee68724d46))
* stop the timer notification showing its icon twice on Android ([bfece69](https://github.com/supercairos/baby-log/commit/bfece6988148c0dccc57a0e3227cfefbda01c556))

## [1.5.1](https://github.com/supercairos/baby-log/compare/baby-log-v1.5.0...baby-log-v1.5.1) (2026-06-04)


### Bug Fixes

* make running-timer notifications actually show on Android ([f014e03](https://github.com/supercairos/baby-log/commit/f014e03ff96631cd3e748d34b7d77caaa71047ea))

## [1.5.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.4.0...baby-log-v1.5.0) (2026-06-04)


### Features

* show the connected instance and app version in the drawer ([45af795](https://github.com/supercairos/baby-log/commit/45af7959de32676c080e3c73674236baf18c3aa7))

## [1.4.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.3.0...baby-log-v1.4.0) (2026-06-04)


### Features

* prompt to refresh on a new version instead of auto-reloading ([c123538](https://github.com/supercairos/baby-log/commit/c123538accc581c64b4177089485f4364f8ca621))
* surface permanently-failed writes as a toast ([de84fd7](https://github.com/supercairos/baby-log/commit/de84fd7e7819c5850900c3303728f7be940510e6))


### Bug Fixes

* align write timestamps to the server clock to avoid future-time 400s ([841999c](https://github.com/supercairos/baby-log/commit/841999c397ad6f64f2490c483e372cb61c2c2b9b))

## [1.3.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.2.0...baby-log-v1.3.0) (2026-06-04)


### Features

* router navigation, live query refresh, and install-to-home action ([44f664c](https://github.com/supercairos/baby-log/commit/44f664c591e2b58292b23c5079d0ad9c60abe7a4))


### Bug Fixes

* drop phantom running timers the server no longer has ([905ab93](https://github.com/supercairos/baby-log/commit/905ab93a0037627022873e952dcea77a121b3b22))
* omit cookies on API calls so a same-origin session can't 403 writes ([ca9870c](https://github.com/supercairos/baby-log/commit/ca9870c842ed0f96100e2f3c799090afe8cada91))
* substitute BASE_PATH placeholder in CSS so self-hosted fonts load ([c5dc793](https://github.com/supercairos/baby-log/commit/c5dc7939f5660e790d249b9839534e30051b8d96))

## [1.2.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.1.1...baby-log-v1.2.0) (2026-06-04)


### Features

* make BASE_PATH a runtime env var (one image, any subpath) ([6d4b7a5](https://github.com/supercairos/baby-log/commit/6d4b7a5be551536272428da11158a21e7478b610))
* notify running timers with a Stop action ([1811112](https://github.com/supercairos/baby-log/commit/1811112cb5438a1c52fe285c86e80a6fde27aab2))

## [1.1.1](https://github.com/supercairos/baby-log/compare/baby-log-v1.1.0...baby-log-v1.1.1) (2026-06-04)


### Bug Fixes

* show the bottle brand mark in the login hero ([b9e8b75](https://github.com/supercairos/baby-log/commit/b9e8b75a083bbf647c5e896161ea8ed6b8d12457))

## [1.1.0](https://github.com/supercairos/baby-log/compare/baby-log-v1.0.0...baby-log-v1.1.0) (2026-06-04)


### Features

* runtime config via react-env ([9501257](https://github.com/supercairos/baby-log/commit/95012576568bc78cef16393b3724f7142d071e18))
* support subpath deployment via BASE_PATH ([2ca5d39](https://github.com/supercairos/baby-log/commit/2ca5d391e7a0ec90648e0680fe1578ece6a3b966))

## 1.0.0 (2026-06-04)


### Features

* initial Baby Log PWA ([d25594d](https://github.com/supercairos/baby-log/commit/d25594d9e0128cc817a56956a33f01833704f102))
