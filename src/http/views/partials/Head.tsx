export interface HeadProps {
    /** Relative to the scripts folder, like `pages/not-found` */
    scripts?: Array<string>;
    /** Relative to the styles folder, like `pages/not-found` */
    styles?: Array<string>;
    title: string;
}

export default function Head({ scripts = [], styles = [], title }: HeadProps): JSX.Element {
    return (
        <head>
            <meta charset="UTF-8" />
            <title safe>{title}</title>
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <link rel="stylesheet" href="/styles/bootstrap.css" />
            <link rel="stylesheet" href="/styles/index.css" />
            {styles.map(name => <link rel="stylesheet" href={`/styles/${name}.css`} />)}
            <script src="/scripts/bootstrap.js" defer></script>
            {scripts.map(name => <script src={`/scripts/${name}.js`} defer></script>)}
        </head>
    );
}
