// Online Stage Help: the help export spec imports docs/help/HELP_AR.md as text (angular.json test `loader: { ".md": "text" }`).
declare module '*.md' {
  const content: string;
  export default content;
}
