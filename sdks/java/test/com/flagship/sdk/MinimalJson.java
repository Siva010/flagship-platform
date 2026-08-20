package com.flagship.sdk;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A deliberately tiny JSON reader, used only to load the conformance fixture.
 *
 * <p>Why hand-rolled: the SDK ships with no dependencies, and the conformance test is the
 * one thing that must be runnable from a bare JDK on any machine. Pulling in Jackson or
 * Gson to read a single committed file would make the cross-language gate harder to run
 * than the thing it is gating.
 *
 * <p>What it does NOT do, honestly:
 *
 * <ul>
 *   <li>Numbers are parsed as {@code long} only. Fractions and exponents are rejected
 *       rather than silently truncated — the fixture holds integer hashes and buckets, and
 *       a float appearing there would be a bug worth failing on.
 *   <li>No duplicate-key detection; a repeated key simply wins.
 *   <li>Errors carry a character offset and nothing else. There is no recovery, no line
 *       numbers, and no attempt at a helpful message beyond what went wrong where.
 *   <li>No streaming — the whole document is materialised into maps and lists. Fine for a
 *       few hundred KB, wrong for anything large.
 * </ul>
 *
 * <p>It is otherwise a correct reader for the JSON grammar it accepts, including surrogate
 * pairs in {@code \\uXXXX} escapes, because a fixture that deliberately contains astral
 * plane characters is exactly the wrong place to cut that corner.
 */
final class MinimalJson {

  private final String source;
  private int position;

  private MinimalJson(String source) {
    this.source = source;
  }

  /** Parses a document into nested {@code Map}, {@code List}, {@code String}, {@code Long}, {@code Boolean} and null. */
  static Object parse(String source) {
    MinimalJson reader = new MinimalJson(source);
    reader.skipWhitespace();
    Object value = reader.readValue();
    reader.skipWhitespace();
    if (reader.position != source.length()) {
      throw reader.error("trailing content after the top-level value");
    }
    return value;
  }

  private Object readValue() {
    char current = peek();
    return switch (current) {
      case '{' -> readObject();
      case '[' -> readArray();
      case '"' -> readString();
      case 't' -> readLiteral("true", Boolean.TRUE);
      case 'f' -> readLiteral("false", Boolean.FALSE);
      case 'n' -> readLiteral("null", null);
      default -> readNumber();
    };
  }

  private Map<String, Object> readObject() {
    expect('{');
    Map<String, Object> members = new LinkedHashMap<>();
    skipWhitespace();
    if (peek() == '}') {
      position++;
      return members;
    }
    while (true) {
      skipWhitespace();
      String key = readString();
      skipWhitespace();
      expect(':');
      skipWhitespace();
      members.put(key, readValue());
      skipWhitespace();
      char separator = next();
      if (separator == '}') {
        return members;
      }
      if (separator != ',') {
        throw error("expected ',' or '}' in object, found '" + separator + "'");
      }
    }
  }

  private List<Object> readArray() {
    expect('[');
    List<Object> elements = new ArrayList<>();
    skipWhitespace();
    if (peek() == ']') {
      position++;
      return elements;
    }
    while (true) {
      skipWhitespace();
      elements.add(readValue());
      skipWhitespace();
      char separator = next();
      if (separator == ']') {
        return elements;
      }
      if (separator != ',') {
        throw error("expected ',' or ']' in array, found '" + separator + "'");
      }
    }
  }

  private String readString() {
    expect('"');
    StringBuilder text = new StringBuilder();
    while (true) {
      char current = next();
      if (current == '"') {
        return text.toString();
      }
      if (current != '\\') {
        text.append(current);
        continue;
      }
      char escape = next();
      switch (escape) {
        case '"' -> text.append('"');
        case '\\' -> text.append('\\');
        case '/' -> text.append('/');
        case 'b' -> text.append('\b');
        case 'f' -> text.append('\f');
        case 'n' -> text.append('\n');
        case 'r' -> text.append('\r');
        case 't' -> text.append('\t');
        // Appended as a bare UTF-16 code unit. A surrogate pair arrives as two
        // consecutive escapes and reassembles itself correctly in the builder.
        case 'u' -> text.append(readUnicodeEscape());
        default -> throw error("unsupported string escape '\\" + escape + "'");
      }
    }
  }

  private char readUnicodeEscape() {
    if (position + 4 > source.length()) {
      throw error("truncated \\u escape");
    }
    String digits = source.substring(position, position + 4);
    position += 4;
    try {
      return (char) Integer.parseInt(digits, 16);
    } catch (NumberFormatException malformed) {
      throw error("malformed \\u escape '" + digits + "'");
    }
  }

  private Long readNumber() {
    int start = position;
    while (position < source.length() && isNumberCharacter(source.charAt(position))) {
      position++;
    }
    String token = source.substring(start, position);
    try {
      return Long.parseLong(token);
    } catch (NumberFormatException notAnInteger) {
      throw error("expected an integer, found '" + token + "'");
    }
  }

  private static boolean isNumberCharacter(char candidate) {
    // Fractions and exponents are swept up here so that Long.parseLong can reject them
    // with a clear message, rather than the parser stopping mid-token and blaming the
    // leftover '.' on the enclosing array.
    return (candidate >= '0' && candidate <= '9')
        || candidate == '-'
        || candidate == '+'
        || candidate == '.'
        || candidate == 'e'
        || candidate == 'E';
  }

  private Object readLiteral(String literal, Object value) {
    if (!source.startsWith(literal, position)) {
      throw error("expected '" + literal + "'");
    }
    position += literal.length();
    return value;
  }

  private void skipWhitespace() {
    while (position < source.length() && Character.isWhitespace(source.charAt(position))) {
      position++;
    }
  }

  private char peek() {
    if (position >= source.length()) {
      throw error("unexpected end of input");
    }
    return source.charAt(position);
  }

  private char next() {
    char current = peek();
    position++;
    return current;
  }

  private void expect(char expected) {
    char current = next();
    if (current != expected) {
      throw error("expected '" + expected + "', found '" + current + "'");
    }
  }

  private IllegalArgumentException error(String message) {
    return new IllegalArgumentException("fixture JSON at offset " + position + ": " + message);
  }
}
