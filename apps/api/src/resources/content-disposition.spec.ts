import { contentDisposition } from './content-disposition.js';

describe('contentDisposition', () => {
  it('sends an ASCII fallback and a UTF-8 filename', () => {
    expect(contentDisposition('Отчёт.pdf')).toBe(
      `attachment; filename="_____.pdf"; filename*=UTF-8''%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf`,
    );
  });

  it('escapes quotes, backslashes and reserved characters', () => {
    expect(contentDisposition(`a"\\'()*% #?.txt`)).toBe(
      `attachment; filename="a__'()*% #?.txt"; filename*=UTF-8''a%22%5C%27%28%29%2A%25%20%23%3F.txt`,
    );
  });
});
