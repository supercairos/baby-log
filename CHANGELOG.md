# Changelog

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
