# Organizador de Trabajos — version web (Supabase + GitHub Pages)

Esta es la version que anda desde cualquier lado, con la PC prendida o apagada.
No tiene servidor propio: el navegador habla directo con Supabase (base de datos
+ archivos), y el sitio en si es un puñado de archivos estaticos que aloja GitHub
Pages gratis.

La version local (carpeta `server.js` / `public/` / `lib/`) sigue funcionando
igual que siempre y no se toco nada de ahi.

## 1. Crear el proyecto en Supabase

1. Entra a [supabase.com](https://supabase.com) con tu cuenta y creá un proyecto nuevo.
2. Andá a **SQL Editor** → **New query**, pegá todo el contenido de
   [`supabase-setup.sql`](supabase-setup.sql) de esta carpeta, y ejecutalo.
   Esto crea la tabla de los trabajos, el lugar donde se guardan los PDFs, y las
   reglas de seguridad (solo tu email puede ver o tocar los datos; si vas a
   entrar con un email distinto de hectorlifter@gmail.com, cambialo en la
   primera funcion del archivo antes de ejecutarlo).
3. Andá a **Authentication** → **Users** → **Add user** y creá tu usuario
   (tu email + una contraseña que elijas vos). Con eso vas a entrar a la app.
   Después, en **Authentication** → **Sign In / Providers**, desactivá la opcion
   **"Allow new users to sign up"**, para que nadie mas pueda registrarse.
4. Andá a **Settings** → **API** y copiá el **Project URL** y la **anon public key**.
5. Abrí `config.js` en esta carpeta y pegalos ahi:
   ```js
   window.SUPABASE_CONFIG = {
     url: 'https://tu-proyecto.supabase.co',
     anonKey: 'tu-anon-key',
   };
   ```

## 2. Publicar en GitHub Pages

1. Subí el contenido de esta carpeta (`web/`) a un repositorio de GitHub.
2. En el repositorio, andá a **Settings** → **Pages**, y elegí la rama y carpeta
   desde donde publicar (por ejemplo, rama `main`, carpeta `/web` si subiste
   todo el proyecto, o `/` si el repo tiene solo esta carpeta).
3. GitHub te va a dar una direccion tipo `https://tu-usuario.github.io/tu-repo/`.
   Esa es la que abrís desde el celular, con la PC prendida o apagada.

## 3. Pasar los datos que ya tenías

Si ya veniás usando la version local con presupuestos cargados, avisame una vez
que tengas el proyecto de Supabase listo (con el paso 1 hecho) y te los migro
yo a la base nueva, con PDFs y todo, para no tener que cargar todo de nuevo.

## Notas

- El login es simple (un solo usuario). Si en algun momento queres agregar
  a alguien mas, se crea otro usuario en **Authentication** → **Users**.
- Los PDFs no son públicos: cada vez que apretás "Ver PDF" se genera un link
  temporal (dura 60 segundos) — por eso no sirve copiarlo y guardarlo para después.
- Capa gratuita de Supabase: 500 MB de base de datos y 1 GB de archivos — de
  sobra para este uso. GitHub Pages es gratis siempre para repos públicos.
