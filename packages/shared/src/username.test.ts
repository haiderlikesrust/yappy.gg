import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { completeProfileBody, createBotBody, registerBody, updateMeBody, username } from './schemas.js';

describe('broadcast mention handles', () => {
  for (const name of ['everyone', 'Everyone', 'EVERYONE', ' everyone ', 'here', 'HERE']) {
    it(`reserves ${JSON.stringify(name)} on all account claim schemas`, () => {
      const registration = { email: 'fixture@example.invalid', password: 'test-password-123', client: { platform: 'android', version: '2.6.0' } };
      const claims = [
        username.safeParse(name),
        registerBody.safeParse({ ...registration, username: name }),
        completeProfileBody.safeParse({ username: name, displayName: 'Fixture' }),
        updateMeBody.safeParse({ username: name }),
        createBotBody.safeParse({ username: name, name: 'Fixture' }),
      ];
      for (const result of claims) {
        assert.equal(result.success, false);
        if (!result.success) assert(result.error.issues.some(issue => issue.message === 'That username is reserved'));
      }
    });
  }
  it('allows ordinary handles that contain a reserved word', () => {
    assert.equal(username.safeParse('everyone123').success, true);
    assert.equal(username.safeParse('here_to_chat').success, true);
  });
});
