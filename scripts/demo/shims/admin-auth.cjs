module.exports = { getAuth: () => ({
    getUserByEmail: async email => ({ uid: `demo-${email}`, email }),
    createUser: async u => ({ uid: `demo-${u.email}`, ...u }),
    updateUser: async (uid, u) => ({ uid, ...u }),
    deleteUser: async () => {}, revokeRefreshTokens: async () => {},
    listUsers: async () => ({ users: [], pageToken: undefined }), setCustomUserClaims: async () => {}
}) };
