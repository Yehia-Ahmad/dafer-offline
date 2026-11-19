// Fixes 1 (cancel a customer payment): a cancelled receipt flags its payment rows with `cancelledAt` instead of deleting them, so
// the old statement lines (and closed periods) never change. Every reader that SUMS payments goes through this.
const activePayments = (payments) => (Array.isArray(payments) ? payments.filter((payment) => !payment.cancelledAt) : []);

module.exports = { activePayments };
