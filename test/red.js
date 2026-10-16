// Stands in for Node-RED's private red.js: getPrivateRED() looks it up among
// require.main.children, so the test file must require it directly.
module.exports = {
    loads: 0,
    nodes: {
        loadFlows: async () => { module.exports.loads++ }
    }
}
