# Yuri 2.5D

[中文](README.md) | [English](README.en.md) | [Español](README.es.md)

A 2.5D runtime and Maker Studio editor plugins for Pokemon Essentials 21.1, with tools for models, billboards, terrain, and lighting.

> **Test version notice**: This project is currently a test version. During development, I used some plugins that cannot be shared publicly due to licensing restrictions. To use the 3D scene editor properly, you will need to write your own compatibility plugin for Maker Studio and make a few adjustments to [mkxp-z-ext](https://github.com/luka-sj/mkxp-z-ext).

## Installation

You need a Pokemon Essentials 21.1 project, [Maker Studio](https://github.com/Toskan4134/maker-studio), and a [mkxp-z-ext](https://github.com/luka-sj/mkxp-z-ext) build that supports this plugin's 2.5D features. Your base project must already include the required compatibility changes; copying this package alone does not adapt the engine or base project. The engine and Maker Studio application are not included.

1. **Back up and close your project**: Back up the entire project, then close the game and Maker Studio. When upgrading, disable the old model and terrain plugins in Maker Studio first.
2. **Copy the plugins**: Copy this package's `Plugins` folder into your project root and merge it with the existing `Plugins` folder. Do not delete the entire existing folder.
3. **Copy the configuration**: Copy `examples/PBS/map_3d.txt` from this package into your project's `PBS` folder.

Asset locations are listed below. Compatibility across Maker Studio versions and full operation in a fresh project have not yet been comprehensively tested.

## Asset Locations

**Provide your own assets. Models and textures use `Graphics/MakerStudioPseudo3D/Models/`, which the editor creates as needed when importing and saving. Copying files there alone does not import them into a scene.**

| Project path | Contents |
| --- | --- |
| `Graphics/MakerStudioPseudo3D/Models/` | Models and textures, including the editor-generated `Edited/` subfolder |
| `Data/MakerStudioPseudo3D/library.json` | Shared asset library, with some images embedded in it |
| `Data/MakerStudioPseudo3D/MapNNN.json` | Map objects, hierarchy, light sources, and effects |
| `Data/MakerStudioTerrain/MapNNN.json` | Terrain data |

The editor creates the assets, library, and map data. Keep these when distributing your game. `Graphics/MakerStudioPseudo3D/BatchCache/` and `Data/MakerStudioPseudo3D/Cache/` are generated caches and do not need to be created manually.

## Lighting

1. In the properties panel's **Scene rendering** section (场景渲染), enable **Dynamic scene lighting** (动态场景照明) and adjust **Ambient brightness**. Lowering the ambient brightness makes the lighting easier to see.
2. Select a model or billboard on the map and enable **Use as dynamic light source** (作为动态光源). Choose a point light or a streetlight (downward cone), then adjust its color, radius, height, and intensity. Streetlights also have controls for direction, cone angle, and beam opacity.
3. Save and restart the game to see the result. Object light sources are saved with the map data; scene lighting settings are synchronized with `PBS/map_3d.txt`.

**Scene lighting** (set in Scene rendering or PBS, rather than in event comments):

| Parameter | Field name | Default | Description |
| --- | --- | --- | --- |
| Dynamic scene lighting | `PointLighting` | `false` | Set to `true` to enable object and event light sources |
| Ambient brightness | `AmbientLight` | 1 | 0.1~1.5; lower values darken the scene and make lights more visible |
| Visible light limit | `MaxLights` | 8 | 1~8; maximum number of active lights. When exceeded, lights closer to the screen center take priority |

**Individual light sources** (set in object properties, or use the internal names below in event comments; distances and heights are in pixels):

| Parameter | Field name | Default | Description |
| --- | --- | --- | --- |
| Use as dynamic light source | `enabled` (object data only) | Off | Enable in the editor. For events, adding `<P3D_LIGHT ...>` enables the light automatically; omit this parameter |
| Light type | `type` | `point` | `point` emits light in all directions; `street` emits light in a downward cone |
| Light color | `color` | `#ffe0a0` | Six-digit hexadecimal color; warm yellow by default |
| Lighting radius | `radius` | 128 | 8~640; measured from the light source. Higher values increase its reach |
| Light height | `height` | 48 | 0~512; relative to the ground below. Object lights also follow the object's elevation offset |
| Light intensity | `intensity` | 0.8 | 0~3; higher values are brighter; 0 produces no illumination |
| Pulse amplitude | `breath` | 0.08 | 0~0.5; amount of periodic brightness variation; 0 gives constant brightness |
| Pulse period (seconds) | `period` | 3.5 | 0.5~30; time for one brightness cycle. Higher values slow the pulse |
| Light X offset | `offsetX` | 0 | -256~256; positive values move the light source right |
| Light Y offset | `offsetY` | 0 | -256~256; positive values move the light source toward the bottom of the map |
| Light height offset | `offsetZ` | 0 | -256~256; positive values move the light source up |

**Streetlight parameters** (choose Streetlight in the editor, or add `type=street` to the event comment):

| Parameter | Field name | Default | Description |
| --- | --- | --- | --- |
| Tilt angle | `tilt` | 0 | -75~75 degrees; 0 points straight down. Positive and negative values tilt in opposite directions |
| Tilt direction | `heading` | 0 | -360~360 degrees; 0 points toward the bottom of the map, 90 right, 180 up, and 270 left. Has no effect when pointing straight down |
| Cone angle | `coneAngle` | 50 | 10~140 degrees; higher values widen the cone |
| Edge softness | `softness` | 0.35 | 0.01~1; higher values soften the edge of the illuminated area |
| Beam opacity | `beam` | 0.22 | 0~1; higher values make the beam more visible; 0 hides it |

A streetlight's radius must exceed its height to reach the ground. Hiding the beam does not disable surface illumination.

**Event light example**: Add a **Comment** command to an event page and enter the following. Use `name=value`, separating parameters with spaces. Omitted parameters use the defaults in the tables.

```text
<P3D_LIGHT color=#ffe0a0 radius=160 height=64 intensity=1 breath=0>
```

This creates a warm yellow point light with a radius of 160 pixels, a height of 64 pixels, an intensity of 1, and constant brightness. Enable Dynamic scene lighting first. The light moves with the event and is active only while the event page containing the comment is active.

## Configuration

Global settings are in `Plugins/MakerStudioPseudo3D/001_Settings.rb`.
Use `PBS/map_3d.txt` for per-map settings; see `examples/PBS/map_3d.txt` for an example.
