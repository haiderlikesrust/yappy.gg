# Landing-page assets

- `yapper-world.webp`: original generated artwork based on the existing Yappy
  logo, optimized to 1200 × 800. The landing page loads it lazily.
- `fonts/SpaceGrotesk.ttf`: locally hosted Space Grotesk variable font.
  Its SIL Open Font License is in `fonts/OFL-SpaceGrotesk.txt`.

The landing page remains a static site served from `web/` by the existing
Caddy configuration. It requires no application build or new runtime dependency.
