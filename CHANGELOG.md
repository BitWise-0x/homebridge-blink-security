# Changelog

All notable changes to this project will be documented in this file. See
[Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.4.0](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.3.0...v1.4.0) (2026-04-12)

### Features

* **streaming:** add IMMI retry logic, ffmpeg resilience, and v4 homescreen discovery ([e835c55](https://github.com/BitWise-0x/homebridge-blink-security/commit/e835c55281265a38892b41992f7bd0d1619d9c46))

## [1.3.0](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.9...v1.3.0) (2026-04-10)

### Features

* **api:** upgrade liveview endpoints to match official Blink app and add lv_save control ([cec89e3](https://github.com/BitWise-0x/homebridge-blink-security/commit/cec89e33161e9b29c5c57d0754a2a72374dfdb08))

## [1.2.9](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.8...v1.2.9) (2026-04-01)

### Reverts

* Revert "chore(release): 1.2.8 [skip ci]" ([fe50736](https://github.com/BitWise-0x/homebridge-blink-security/commit/fe50736cce734f8e5994bdbec055efbc2da1387f))
* Revert "fix(thumbnails): serialize thumbnail commands per sync module" ([09f044a](https://github.com/BitWise-0x/homebridge-blink-security/commit/09f044a51ced197721c0575d9934f1cfe8e7427d))

## [1.2.7](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.6...v1.2.7) (2026-04-01)

### Bug Fixes

* **thumbnails:** clear cache after stream ends regardless of refresh result ([45d9c3f](https://github.com/BitWise-0x/homebridge-blink-security/commit/45d9c3f8d224f6bc7a9aa20b7c8b15c76f1965aa))

## [1.2.6](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.5...v1.2.6) (2026-03-31)

### Bug Fixes

* **deps:** migrate camera-utils import from CJS require to ESM ([6256ea8](https://github.com/BitWise-0x/homebridge-blink-security/commit/6256ea8ca7abfc177fac39e3f9aeaa3f6a75f182))

## [1.2.5](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.4...v1.2.5) (2026-03-29)

### Bug Fixes

* **deps:** update minor and patch dependencies ([668728d](https://github.com/BitWise-0x/homebridge-blink-security/commit/668728da72907b33a214ea75b30c79f38fe9dea5))

## [1.2.4](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.3...v1.2.4) (2026-03-19)

### Bug Fixes

* **doorbell:** repopulate thumbnail from recent media after 404 clearance ([e05aee2](https://github.com/BitWise-0x/homebridge-blink-security/commit/e05aee263bf8e46a2ef745b61c435bbb52ec5947))

## [1.2.3](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.2...v1.2.3) (2026-03-19)

### Bug Fixes

* **doorbell:** resolve false press events and stale thumbnail 404s ([ec00a04](https://github.com/BitWise-0x/homebridge-blink-security/commit/ec00a042273309cb658809863e3548be6535ac9d))

## [1.2.2](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.1...v1.2.2) (2026-03-19)

### Bug Fixes

* **discovery:** synthesize doorbell data with guaranteed id and network_id ([a259cec](https://github.com/BitWise-0x/homebridge-blink-security/commit/a259cec916969241cd1e5a9d52ce3c839b49c1ae))

## [1.2.1](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.2.0...v1.2.1) (2026-03-19)

### Bug Fixes

* **discovery:** fallback doorbell detection via recent media for missing doorbell_buttons ([a6f1cea](https://github.com/BitWise-0x/homebridge-blink-security/commit/a6f1cea5e67def8b2892ecced1e60a21315cc41f))

## [1.2.0](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.9...v1.2.0) (2026-03-06)

### Features

* **certification:** add verified by Homebridge badge to README ([8e719ba](https://github.com/BitWise-0x/homebridge-blink-security/commit/8e719ba3cfe16096785dff5308951aa2bdc69662))

## [1.1.9](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.8...v1.1.9) (2026-03-04)

### Bug Fixes

* refresh thumbnail after live view for all cameras and resolve lint warnings ([1ce02bf](https://github.com/BitWise-0x/homebridge-blink-security/commit/1ce02bf6c756efd13066f12fedb14adb04b358ca))

## [1.1.8](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.7...v1.1.8) (2026-03-04)

### Bug Fixes

* use RTSP-to-MPEGTS proxy with re-encoding for Blink XT live view ([e1eb6d7](https://github.com/BitWise-0x/homebridge-blink-security/commit/e1eb6d7d4344f2949e2abe09cd5cc652b94a3a6b))

## [1.1.7](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.6...v1.1.7) (2026-03-03)

### Bug Fixes

* correct CSeq tracking and TLS race condition in RTSP proxy ([dd2a31c](https://github.com/BitWise-0x/homebridge-blink-security/commit/dd2a31cc3cfc8f632e56aedb7943091903926c14))

## [1.1.6](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.5...v1.1.6) (2026-03-03)

### Bug Fixes

* use CSeq-correcting TLS proxy for RTSP live view streams ([331ddb1](https://github.com/BitWise-0x/homebridge-blink-security/commit/331ddb1606c901d8455a304fa037a9a545429c5b))

## [1.1.5](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.4...v1.1.5) (2026-03-03)

### Bug Fixes

* pass RTSPS URL directly to ffmpeg instead of TLS proxy ([86db4e8](https://github.com/BitWise-0x/homebridge-blink-security/commit/86db4e8c00b47dfb48bd184761fc5dedf4771cbd))

## [1.1.4](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.3...v1.1.4) (2026-03-03)

### Bug Fixes

* remove RTSP response rewriting that corrupted stream negotiation ([f44d07d](https://github.com/BitWise-0x/homebridge-blink-security/commit/f44d07d851f1251d4f2f6c1df2443076fdaf2986))

## [1.1.3](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.2...v1.1.3) (2026-03-03)

### Bug Fixes

* handle RTSP TCP interleaved frames in TLS proxy ([af44b55](https://github.com/BitWise-0x/homebridge-blink-security/commit/af44b55306a99cdaf74c021152dfc8bfda291ac9))

## [1.1.2](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.1...v1.1.2) (2026-03-03)

### Bug Fixes

* use TCP transport for RTSP streams ([eaff233](https://github.com/BitWise-0x/homebridge-blink-security/commit/eaff233ca7c2b8c919607139758311740a3aa35a))

## [1.1.1](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.1.0...v1.1.1) (2026-03-03)

### Bug Fixes

* move RTSP user_agent before -i input flag ([6bf1319](https://github.com/BitWise-0x/homebridge-blink-security/commit/6bf13196c0454f2f66a0265da8242eac6d4990c0))

## [1.1.0](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.4...v1.1.0) (2026-03-03)

### Features

* add audio streaming, fix XT liveview, improve retry timing ([da264a1](https://github.com/BitWise-0x/homebridge-blink-security/commit/da264a1f45582467b759b71386840481f4f4aacb))

## [1.0.4](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.3...v1.0.4) (2026-03-01)

### Bug Fixes

* refresh thumbnail after live stream ends ([6b9f401](https://github.com/BitWise-0x/homebridge-blink-security/commit/6b9f40168b3bccba40bbf48a116d0073710d1449))

## [1.0.3](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.2...v1.0.3) (2026-03-01)

### Bug Fixes

* mark username and password as required in config schema ([f33e837](https://github.com/BitWise-0x/homebridge-blink-security/commit/f33e8374ecfdbed3100fce0a78c6efd7915e5c17))

## [1.0.3](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.2...v1.0.3) (2026-03-01)

### Bug Fixes

* mark username and password as required in config schema ([f33e837](https://github.com/BitWise-0x/homebridge-blink-security/commit/f33e8374ecfdbed3100fce0a78c6efd7915e5c17))

## [1.0.2](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.1...v1.0.2) (2026-02-28)

### Bug Fixes

* wrong screenshot ([48a3973](https://github.com/BitWise-0x/homebridge-blink-security/commit/48a39736322529fdff7ee5e17fd44506328f39cf))

## [1.0.1](https://github.com/BitWise-0x/homebridge-blink-security/compare/v1.0.0...v1.0.1) (2026-02-28)

### Bug Fixes

* enable liveview by default in config schema ([ddbcfb5](https://github.com/BitWise-0x/homebridge-blink-security/commit/ddbcfb5b34454c5488e379f049698ec4a10489ab))

## 1.0.0 (2026-02-27)

### Features

* initial public release ([249c381](https://github.com/BitWise-0x/homebridge-blink-security/commit/249c3811cdc67ee25dfc84a1335af216cbfa427a))
