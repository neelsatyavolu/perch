// The hero's entrance and the moments' guard (tasteskill starter.html head lines), as a file so the
// site's CSP can stay script-src 'self'.
document.documentElement.classList.add('m-enter', 'mo-js');
setTimeout(() => document.documentElement.classList.add('m-enter-done'), 700);
setTimeout(() => document.documentElement.classList.add('mo-safe'), 2500);
