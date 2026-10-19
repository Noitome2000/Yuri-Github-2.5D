# Yuri 2.5D

[中文](README.md) | [English](README.en.md) | [Español](README.es.md)

Un sistema de renderizado 2.5D y plugins del editor Maker Studio para Pokemon Essentials 21.1, con herramientas para modelos, imágenes en plano (billboards), terreno e iluminación.

> **Aviso sobre la versión de prueba**: Este proyecto se encuentra actualmente en fase de pruebas. Durante el desarrollo utilicé algunos plugins que no puedo compartir públicamente debido a restricciones de licencia. Para utilizar correctamente el editor de escenas 3D, tendrás que crear tu propio plugin de compatibilidad para Maker Studio y realizar algunos ajustes en [mkxp-z-ext](https://github.com/luka-sj/mkxp-z-ext).

## Instalación

Necesitas un proyecto de Pokemon Essentials 21.1, [Maker Studio](https://github.com/Toskan4134/maker-studio) y una versión de [mkxp-z-ext](https://github.com/luka-sj/mkxp-z-ext) compatible con las funciones 2.5D de este plugin. El proyecto base debe tener ya las adaptaciones necesarias; copiar este paquete por sí solo no adapta el motor ni el proyecto base. El motor y la aplicación Maker Studio no están incluidos.

1. **Haz una copia de seguridad y cierra el proyecto**: Guarda una copia del proyecto completo y cierra el juego y Maker Studio. Si estás actualizando, desactiva primero los plugins anteriores de modelos y terreno en Maker Studio.
2. **Copia los plugins**: Copia la carpeta `Plugins` del paquete en la raíz del proyecto y combínala con la carpeta `Plugins` existente. No elimines la carpeta existente completa.
3. **Copia la configuración**: Copia `examples/PBS/map_3d.txt` del paquete en la carpeta `PBS` de tu proyecto.

Las ubicaciones de los recursos se indican a continuación. Todavía no se han verificado exhaustivamente la compatibilidad entre versiones de Maker Studio ni el funcionamiento completo en un proyecto nuevo.

## Ubicación de los recursos

**Debes aportar tus propios recursos. Los modelos y las texturas se guardan en `Graphics/MakerStudioPseudo3D/Models/`, que el editor crea cuando es necesario al importar y guardar. Copiar archivos en esa carpeta no los importa automáticamente a una escena.**

| Ruta dentro del proyecto | Contenido |
| --- | --- |
| `Graphics/MakerStudioPseudo3D/Models/` | Modelos y texturas, incluida la subcarpeta `Edited/` generada por el editor |
| `Data/MakerStudioPseudo3D/library.json` | Biblioteca compartida de recursos, con algunas imágenes integradas |
| `Data/MakerStudioPseudo3D/MapNNN.json` | Objetos del mapa, jerarquía, fuentes de luz y efectos |
| `Data/MakerStudioTerrain/MapNNN.json` | Datos del terreno |

El editor crea los recursos, la biblioteca y los datos de los mapas. Consérvalos al distribuir el juego. `Graphics/MakerStudioPseudo3D/BatchCache/` y `Data/MakerStudioPseudo3D/Cache/` son carpetas de caché que se generan automáticamente; no necesitas crearlas a mano.

## Iluminación

1. En la sección **Renderizado de la escena** (场景渲染) del panel de propiedades, activa **Iluminación dinámica de la escena** (动态场景照明) y ajusta el **Brillo ambiental**. Reducir el brillo ambiental permite apreciar mejor las luces.
2. Selecciona un modelo o billboard del mapa y activa **Usar como fuente de luz dinámica** (作为动态光源). Elige una luz puntual o una farola (cono hacia abajo) y ajusta el color, el radio, la altura y la intensidad. Las farolas también permiten ajustar la dirección, el ángulo del cono y la opacidad del haz.
3. Guarda y reinicia el juego para ver el resultado. Las fuentes de luz de los objetos se guardan con los datos del mapa; los ajustes de iluminación de la escena se sincronizan con `PBS/map_3d.txt`.

**Iluminación de la escena** (se configura en Renderizado de la escena o en PBS, no en los comentarios de eventos):

| Parámetro | Nombre del campo | Valor predeterminado | Descripción |
| --- | --- | --- | --- |
| Iluminación dinámica de la escena | `PointLighting` | `false` | Usa `true` para activar las fuentes de luz de objetos y eventos |
| Brillo ambiental | `AmbientLight` | 1 | 0.1~1.5; los valores bajos oscurecen la escena y hacen que las luces destaquen más |
| Límite de luces visibles | `MaxLights` | 8 | 1~8; número máximo de luces activas. Si se supera, tienen prioridad las más cercanas al centro de la pantalla |

**Fuentes de luz individuales** (se configuran en las propiedades del objeto o mediante los nombres internos siguientes en comentarios de eventos; las distancias y alturas se expresan en píxeles):

| Parámetro | Nombre del campo | Valor predeterminado | Descripción |
| --- | --- | --- | --- |
| Usar como fuente de luz dinámica | `enabled` (solo datos de objetos) | Desactivado | Actívalo en el editor. En eventos, añadir `<P3D_LIGHT ...>` activa la luz automáticamente; omite este parámetro |
| Tipo de luz | `type` | `point` | `point` emite luz en todas las direcciones; `street` emite luz en un cono hacia abajo |
| Color de la luz | `color` | `#ffe0a0` | Color hexadecimal de seis dígitos; amarillo cálido de forma predeterminada |
| Radio de iluminación | `radius` | 128 | 8~640; se mide desde la fuente de luz. Un valor mayor aumenta el alcance |
| Altura de la luz | `height` | 48 | 0~512; relativa al suelo situado debajo. Las luces de objetos también siguen el desplazamiento de altura del objeto |
| Intensidad de la luz | `intensity` | 0.8 | 0~3; un valor mayor produce más brillo; 0 no ilumina |
| Amplitud de pulsación | `breath` | 0.08 | 0~0.5; amplitud de la variación periódica del brillo; 0 mantiene el brillo constante |
| Período de pulsación (segundos) | `period` | 3.5 | 0.5~30; duración de un ciclo de brillo. Un valor mayor ralentiza la pulsación |
| Desplazamiento X de la luz | `offsetX` | 0 | -256~256; los valores positivos mueven la fuente de luz a la derecha |
| Desplazamiento Y de la luz | `offsetY` | 0 | -256~256; los valores positivos mueven la fuente de luz hacia la parte inferior del mapa |
| Desplazamiento de altura de la luz | `offsetZ` | 0 | -256~256; los valores positivos elevan la fuente de luz |

**Parámetros exclusivos de las farolas** (elige Farola en el editor o añade `type=street` al comentario del evento):

| Parámetro | Nombre del campo | Valor predeterminado | Descripción |
| --- | --- | --- | --- |
| Ángulo de inclinación | `tilt` | 0 | -75~75 grados; 0 apunta verticalmente hacia abajo. Los valores positivos y negativos inclinan en sentidos opuestos |
| Dirección de inclinación | `heading` | 0 | -360~360 grados; 0 apunta hacia la parte inferior del mapa, 90 a la derecha, 180 hacia arriba y 270 a la izquierda. No tiene efecto si la luz apunta verticalmente hacia abajo |
| Ángulo del cono | `coneAngle` | 50 | 10~140 grados; un valor mayor ensancha el cono |
| Suavidad del borde | `softness` | 0.35 | 0.01~1; un valor mayor suaviza el borde de la zona iluminada |
| Opacidad del haz | `beam` | 0.22 | 0~1; un valor mayor hace más visible el haz; 0 lo oculta |

El radio de una farola debe superar su altura para que la luz alcance el suelo. Ocultar el haz no desactiva la iluminación de las superficies.

**Ejemplo de luz en un evento**: Añade una instrucción **Comentario** a una página del evento e introduce lo siguiente. Usa `nombre=valor` y separa los parámetros con espacios. Los parámetros omitidos usan los valores predeterminados de las tablas.

```text
<P3D_LIGHT color=#ffe0a0 radius=160 height=64 intensity=1 breath=0>
```

Este ejemplo crea una luz puntual de color amarillo cálido, con un radio de 160 píxeles, una altura de 64 píxeles, una intensidad de 1 y brillo constante. Activa primero la Iluminación dinámica de la escena. La luz se mueve con el evento y solo funciona mientras esté activa la página que contiene el comentario.

## Configuración

Los ajustes globales están en `Plugins/MakerStudioPseudo3D/001_Settings.rb`.
Usa `PBS/map_3d.txt` para configurar cada mapa; consulta el ejemplo en `examples/PBS/map_3d.txt`.
