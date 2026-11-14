// TEST BUILDS ONLY. Public half of the test key pair; the private half is derived from a fixed seed inside
// test/helpers/license.js (no key file anywhere). Deleted from the staged backend by scripts/offline/stage.js.
module.exports = {
  TEST_PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA80yAempKgwAolX/2kQgGKlTZzYmq8SSVVu501CMS8/w=
-----END PUBLIC KEY-----`,
};
