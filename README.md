# VideoMap

Play hundreds of videos at the same time on a flat, cylindrical or spherical surface. It uses a map-style video tile pyramid, and a Node CLI builds static output you can host from any folder.

**Status:** milestone 0 (device feasibility test).

- [docs/PLAN.md](docs/PLAN.md) is the implementation plan.
- [spike/](spike/README.md) holds the device test: synthetic tile generator, LAN server and WebGL ramp test.

```sh
npm run spike:generate   # needs ffmpeg
npm run spike:serve      # open the printed LAN URL on a phone
```
