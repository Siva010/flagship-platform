package com.flagship.sdk;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * The Java SDK's test suite, run as a plain main class.
 *
 * <p>No JUnit, by design: this suite is the cross-language conformance gate, and it should
 * run on a bare JDK with nothing fetched from a network. The trade-off is a hand-written
 * runner and assertions that report rather than throw, so one divergent case does not hide
 * the other 499.
 *
 * <pre>
 *   javac -encoding UTF-8 -d out $(find src test -name '*.java')
 *   java -cp out com.flagship.sdk.ConformanceTest
 * </pre>
 *
 * <p>Run from {@code sdks/java}; the fixture is located relative to the working directory,
 * the same way the Go SDK's conformance test locates it.
 */
public final class ConformanceTest {

  private static final Path FIXTURE_PATH = Path.of("..", "..", "spec", "conformance", "bucketing.json");

  private final List<String> failures = new ArrayList<>();

  public static void main(String[] arguments) throws IOException {
    ConformanceTest suite = new ConformanceTest();
    Path fixturePath = arguments.length > 0 ? Path.of(arguments[0]) : FIXTURE_PATH;

    suite.everyFixtureCaseProducesTheRecordedInputHashAndBucket(fixturePath);
    suite.hashMatchesPublishedReferenceVectors();
    suite.hashCoversUtf8BytesRatherThanUtf16CodeUnits();
    suite.hashStaysWithinUnsignedThirtyTwoBitRange();
    suite.bucketIsNeverNegativeAndAlwaysBelowBucketSpace();
    suite.hashRespondsToTheSeed();
    suite.variationForBucketFollowsDeclarationOrder();
    suite.malformedDistributionYieldsNoVariation();

    suite.report();
  }

  /**
   * The cross-language gate. Every case must agree with the TypeScript reference on the
   * joined input, the raw hash, and the bucket, or the SDKs have drifted.
   */
  private void everyFixtureCaseProducesTheRecordedInputHashAndBucket(Path fixturePath)
      throws IOException {
    String raw = Files.readString(fixturePath, StandardCharsets.UTF_8);
    Map<String, Object> fixture = asObject(MinimalJson.parse(raw));

    long fixtureBucketSpace = (Long) fixture.get("bucketSpace");
    if (fixtureBucketSpace != Bucketing.BUCKET_SPACE) {
      failures.add(
          "bucket space mismatch: fixture=" + fixtureBucketSpace + " sdk=" + Bucketing.BUCKET_SPACE);
      return;
    }

    List<?> cases = (List<?>) fixture.get("cases");
    if (cases == null || cases.isEmpty()) {
      failures.add("fixture contains no cases; it is not a valid conformance run");
      return;
    }

    int verified = 0;
    for (Object element : cases) {
      Map<String, Object> testCase = asObject(element);
      String flagKey = (String) testCase.get("flagKey");
      String salt = (String) testCase.get("salt");
      String bucketKey = (String) testCase.get("bucketKey");
      String expectedInput = (String) testCase.get("input");
      long expectedHash = (Long) testCase.get("hash");
      long expectedBucket = (Long) testCase.get("expectedBucket");

      String actualInput = Bucketing.bucketingInput(flagKey, salt, bucketKey);
      if (!actualInput.equals(expectedInput)) {
        failures.add(
            "input mismatch: got " + quote(actualInput) + ", want " + quote(expectedInput));
        continue;
      }

      long actualHash = MurmurHash3.hashUtf8(expectedInput, 0);
      if (actualHash != expectedHash) {
        failures.add(
            "hash mismatch for "
                + quote(expectedInput)
                + ": got "
                + actualHash
                + ", want "
                + expectedHash);
        continue;
      }

      long actualBucket = Bucketing.bucketFor(flagKey, salt, bucketKey);
      if (actualBucket != expectedBucket) {
        failures.add(
            "bucket mismatch for "
                + quote(expectedInput)
                + ": got "
                + actualBucket
                + ", want "
                + expectedBucket);
        continue;
      }
      verified++;
    }
    System.out.println("verified " + verified + " of " + cases.size() + " conformance cases");
  }

  /**
   * Checks the port against published vectors rather than only against the fixture, so a
   * shared misunderstanding between implementations by one author cannot pass unnoticed.
   */
  private void hashMatchesPublishedReferenceVectors() {
    // Canonical smhasher values for seed 0.
    record Vector(String input, long expected) {}
    List<Vector> vectors =
        List.of(
            new Vector("", 0L),
            new Vector("a", 0x3c2569b2L),
            new Vector("ab", 0x9bbfd75fL),
            new Vector("abc", 0xb3dd93faL),
            new Vector("abcd", 0x43ed676aL),
            new Vector("Hello, world!", 0xc0363e43L));

    for (Vector vector : vectors) {
      long actual = MurmurHash3.hashUtf8(vector.input(), 0);
      if (actual != vector.expected()) {
        failures.add(
            "reference vector "
                + quote(vector.input())
                + ": got 0x"
                + Long.toHexString(actual)
                + ", want 0x"
                + Long.toHexString(vector.expected()));
      }
    }
  }

  private void hashCoversUtf8BytesRatherThanUtf16CodeUnits() {
    // "é" is one UTF-16 code unit but two UTF-8 bytes; "🎉" is a surrogate pair, one code
    // point, four UTF-8 bytes. An implementation iterating charAt would hash a different
    // byte sequence and diverge from Go and TypeScript on exactly these inputs.
    for (String sample : List.of("é", "ユーザー", "🎉", "user-🎉")) {
      byte[] utf8 = sample.getBytes(StandardCharsets.UTF_8);
      if (MurmurHash3.hashUtf8(sample, 0) != MurmurHash3.hash(utf8, 0)) {
        failures.add("string path disagrees with the UTF-8 byte path for " + quote(sample));
      }
    }
    if ("é".length() != 1 || "é".getBytes(StandardCharsets.UTF_8).length != 2) {
      failures.add("the é sample is no longer a one-unit, two-byte character; the test is void");
    }
    if ("🎉".length() != 2 || "🎉".getBytes(StandardCharsets.UTF_8).length != 4) {
      failures.add("the 🎉 sample is no longer a surrogate pair; the test is void");
    }
  }

  private void hashStaysWithinUnsignedThirtyTwoBitRange() {
    // The signed-int trap: a naive Java port leaks a sign bit and returns a negative hash
    // for roughly half of all inputs.
    for (int index = 0; index < 5000; index++) {
      long hash = MurmurHash3.hashUtf8("key-" + index, 0);
      if (hash < 0 || hash > 0xFFFFFFFFL) {
        failures.add("hash out of uint32 range for key-" + index + ": " + hash);
        return;
      }
    }
  }

  private void bucketIsNeverNegativeAndAlwaysBelowBucketSpace() {
    // Java's % keeps the sign of its left operand, so a hash that reached the modulo still
    // signed would produce negative buckets — which index out of every rollout table.
    for (int index = 0; index < 5000; index++) {
      int bucket = Bucketing.bucketFor("flag-" + index, "salt-a", "user-" + index);
      if (bucket < 0 || bucket >= Bucketing.BUCKET_SPACE) {
        failures.add("bucket out of range for user-" + index + ": " + bucket);
        return;
      }
    }
  }

  private void hashRespondsToTheSeed() {
    if (MurmurHash3.hashUtf8("abc", 0) == MurmurHash3.hashUtf8("abc", 1)) {
      failures.add("the seed is being ignored");
    }
  }

  private void variationForBucketFollowsDeclarationOrder() {
    List<Distribution> even =
        List.of(new Distribution("control", 50_000), new Distribution("treatment", 50_000));

    if (!Bucketing.isValidDistribution(even)) {
      failures.add("an even two-way split should be a valid distribution");
    }

    record Boundary(int bucket, String expected) {}
    List<Boundary> boundaries =
        List.of(
            new Boundary(0, "control"),
            new Boundary(49_999, "control"),
            new Boundary(50_000, "treatment"),
            new Boundary(99_999, "treatment"));

    for (Boundary boundary : boundaries) {
      Optional<String> actual = Bucketing.variationForBucket(even, boundary.bucket());
      if (actual.isEmpty() || !actual.get().equals(boundary.expected())) {
        failures.add(
            "variationForBucket(" + boundary.bucket() + ") = " + actual + ", want " + boundary.expected());
      }
    }
  }

  private void malformedDistributionYieldsNoVariation() {
    if (Bucketing.variationForBucket(List.of(), 0).isPresent()) {
      failures.add("an empty distribution should serve no variation");
    }
    if (Bucketing.isValidDistribution(List.of(new Distribution("control", 1)))) {
      failures.add("weights summing to less than the bucket space should be rejected");
    }
  }

  private void report() {
    if (failures.isEmpty()) {
      System.out.println("PASS: all Java SDK bucketing assertions hold");
      return;
    }
    System.out.println("FAIL: " + failures.size() + " assertion(s) did not hold");
    // Capped because a byte-order or sign error fails all 500 cases identically, and 500
    // copies of the same message buries whatever else broke.
    failures.stream().limit(20).forEach(failure -> System.out.println("  " + failure));
    if (failures.size() > 20) {
      System.out.println("  ... " + (failures.size() - 20) + " more");
    }
    System.exit(1);
  }

  @SuppressWarnings("unchecked") // The fixture's shape is fixed by spec/BUCKETING.md.
  private static Map<String, Object> asObject(Object value) {
    return (Map<String, Object>) value;
  }

  private static String quote(String value) {
    return '"' + value + '"';
  }

  private ConformanceTest() {}
}
