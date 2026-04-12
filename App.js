import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audio } from 'expo-av';
import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
  useFonts,
} from '@expo-google-fonts/poppins';

const DATA_URL =
  'https://raw.githubusercontent.com/iMahir/gre-vocab-app/refs/heads/main/GRE_Words.json';

const STATE_LABELS = {
  mastered: 'Mastered',
  reviewing: 'Reviewing',
  learning: 'Learning',
};

// UI Colors for states
const STATE_COLORS = {
  mastered: '#4CAF50', // Green
  reviewing: '#FF9800', // Orange
  learning: '#F44336', // Red
};

const STUDY_MODES = {
  flashcard: 'flashcard',
  quiz: 'quiz',
};

const STORAGE_KEYS = {
  statuses: (groupName) => `gre/statuses/${groupName}`,
  cardIndex: (groupName) => `gre/card-index/${groupName}`,
};

// Minimum flex value so a zero-count segment stays visible as a sliver
const MIN_PROGRESS_FLEX = 0.01;

function shuffleArray(values) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function normalizeCardIndex(index, total) {
  if (!total) {
    return 0;
  }
  return ((index % total) + total) % total;
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });

  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [selectedGroupIndex, setSelectedGroupIndex] = useState(null);
  const [studyMode, setStudyMode] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [globalStatuses, setGlobalStatuses] = useState({});
  const [cardIndex, setCardIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [quizOptions, setQuizOptions] = useState([]);
  const [quizSelectedOption, setQuizSelectedOption] = useState('');
  const [quizResult, setQuizResult] = useState(null);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });
  const [searchQuery, setSearchQuery] = useState('');

  const soundRef = useRef(null);
  const autoAdvanceRef = useRef(null);

  const selectedGroup =
    selectedGroupIndex === null ? null : groups[selectedGroupIndex] ?? null;
  const words = selectedGroup?.words ?? [];
  const totalWords = words.length;

  const uniqueDefinitionCount = useMemo(
    () =>
      new Set(
        groups
          .flatMap((group) => group.words ?? [])
          .map((item) => item.definition)
          .filter(Boolean)
      ).size,
    [groups]
  );
  const canPlayQuiz = uniqueDefinitionCount >= 4;

  const currentWord = useMemo(() => {
    const wordCount = words.length;
    if (!wordCount) {
      return null;
    }
    const normalizedIndex = normalizeCardIndex(cardIndex, wordCount);
    return words[normalizedIndex];
  }, [cardIndex, words]);

  const counts = useMemo(() => {
    return words.reduce(
      (acc, item) => {
        const state = statuses[item.word];
        if (state && acc[state] !== undefined) {
          acc[state] += 1;
        }
        return acc;
      },
      { mastered: 0, reviewing: 0, learning: 0 }
    );
  }, [statuses, words]);

  // Global Progress Logic
  const allWordsCount = useMemo(() => {
    return groups.reduce((acc, group) => acc + (group.words?.length || 0), 0);
  }, [groups]);

  const globalCounts = useMemo(() => {
    return Object.values(globalStatuses).reduce(
      (acc, state) => {
        if (acc[state] !== undefined) acc[state] += 1;
        return acc;
      },
      { mastered: 0, reviewing: 0, learning: 0 }
    );
  }, [globalStatuses]);

  const globalUnseenCount = useMemo(
    () =>
      Math.max(
        0,
        allWordsCount - globalCounts.mastered - globalCounts.reviewing - globalCounts.learning
      ),
    [allWordsCount, globalCounts]
  );

  // Search Logic
  const filteredSearchWords = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const lowerQuery = searchQuery.toLowerCase();
    return groups
      .flatMap((g) => g.words)
      .filter((w) => w.word.toLowerCase().includes(lowerQuery));
  }, [searchQuery, groups]);

  const loadWords = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(DATA_URL);
      if (!response.ok) {
        throw new Error(`Failed to fetch words (${response.status})`);
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error('Invalid words payload.');
      }
      setGroups(payload);

      // Load all global statuses to calculate overall progress
      let allStatuses = {};
      for (const group of payload) {
        const saved = await AsyncStorage.getItem(STORAGE_KEYS.statuses(group.group));
        if (saved) {
          allStatuses = { ...allStatuses, ...JSON.parse(saved) };
        }
      }
      setGlobalStatuses(allStatuses);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load words.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWords();
  }, [loadWords]);

  useEffect(() => {
    return () => {
      if (soundRef.current) {
        soundRef.current.unloadAsync();
      }
      if (autoAdvanceRef.current !== null) {
        clearTimeout(autoAdvanceRef.current);
      }
    };
  }, []);

  const resetQuizState = useCallback(() => {
    setQuizOptions([]);
    setQuizSelectedOption('');
    setQuizResult(null);
  }, []);

  const persistGroupProgress = useCallback(
    async (nextStatuses, nextCardIndex) => {
      if (!selectedGroup) return;
      try {
        await AsyncStorage.multiSet([
          [
            STORAGE_KEYS.statuses(selectedGroup.group),
            JSON.stringify(nextStatuses ?? statuses),
          ],
          [
            STORAGE_KEYS.cardIndex(selectedGroup.group),
            String(nextCardIndex ?? cardIndex),
          ],
        ]);
        // Update global statuses for dashboard
        setGlobalStatuses((prev) => ({ ...prev, ...nextStatuses }));
      } catch {
        setError('Could not save progress locally.');
      }
    },
    [cardIndex, selectedGroup, statuses]
  );

  const openGroup = useCallback(async (groupIndex) => {
    const group = groups[groupIndex];
    if (!group) return;

    setSelectedGroupIndex(groupIndex);
    setStudyMode(null);
    setShowDetails(false);
    resetQuizState();
    setQuizScore({ correct: 0, total: 0 });

    try {
      const [savedStatuses, savedCardIndex] = await AsyncStorage.multiGet([
        STORAGE_KEYS.statuses(group.group),
        STORAGE_KEYS.cardIndex(group.group),
      ]);

      let parsedStatuses = {};
      if (savedStatuses?.[1]) {
        try {
          parsedStatuses = JSON.parse(savedStatuses[1]);
        } catch {
          setError('Saved deck data was corrupted and has been reset.');
        }
      }
      const parsedCardIndex = Number.parseInt(savedCardIndex?.[1] ?? '0', 10);

      setStatuses(parsedStatuses && typeof parsedStatuses === 'object' ? parsedStatuses : {});
      setCardIndex(Math.max(Number.isNaN(parsedCardIndex) ? 0 : parsedCardIndex, 0));
    } catch {
      setStatuses({});
      setCardIndex(0);
      setError('Could not read saved progress for this deck.');
    }
  }, [groups, resetQuizState]);

  const backToDecks = useCallback(() => {
    setSelectedGroupIndex(null);
    setStudyMode(null);
    setShowDetails(false);
    resetQuizState();
    setQuizScore({ correct: 0, total: 0 });
    setSearchQuery('');
  }, [resetQuizState]);

  const playPronunciation = useCallback(async () => {
    if (!currentWord?.audio_url) return;

    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
      const { sound } = await Audio.Sound.createAsync({
        uri: currentWord.audio_url,
      });
      soundRef.current = sound;
      await sound.playAsync();
    } catch {
      setError('Unable to play pronunciation audio.');
    }
  }, [currentWord]);

  useEffect(() => {
    if (!currentWord || studyMode !== STUDY_MODES.quiz) {
      resetQuizState();
      return;
    }

    const correctDefinition = currentWord.definition;
    const allDefinitions = Array.from(
      new Set(
        groups
          .flatMap((group) => group.words ?? [])
          .map((item) => item.definition)
          .filter((definition) => definition && definition !== correctDefinition)
      )
    );

    const deckDefinitions = Array.from(
      new Set(
        words
          .filter((item) => item.word !== currentWord.word)
          .map((item) => item.definition)
          .filter((definition) => definition && definition !== correctDefinition)
      )
    );

    const incorrectDefinitions = shuffleArray(
      Array.from(new Set([...deckDefinitions, ...allDefinitions]))
    ).slice(0, 3);

    if (incorrectDefinitions.length < 3) {
      resetQuizState();
      return;
    }

    setQuizOptions(shuffleArray([correctDefinition, ...incorrectDefinitions]));
    setQuizSelectedOption('');
    setQuizResult(null);
  }, [currentWord, groups, resetQuizState, studyMode, words]);

  const classifyWord = useCallback(
    async (state) => {
      if (!currentWord || !selectedGroup) return;

      const nextStatuses = { ...statuses, [currentWord.word]: state };
      if (!totalWords) return;

      const normalizedCardIndex = normalizeCardIndex(cardIndex, totalWords);
      const nextCardIndex = (normalizedCardIndex + 1) % totalWords;

      setStatuses(nextStatuses);
      setCardIndex(nextCardIndex);
      setShowDetails(false);
      await persistGroupProgress(nextStatuses, nextCardIndex);
    },
    [cardIndex, currentWord, persistGroupProgress, selectedGroup, statuses, totalWords]
  );

  const selectMode = useCallback(
    (mode) => {
      if (mode === STUDY_MODES.quiz && !canPlayQuiz) return;
      setStudyMode(mode);
      setShowDetails(false);
      resetQuizState();
    },
    [canPlayQuiz, resetQuizState]
  );

  const backToModes = useCallback(() => {
    setStudyMode(null);
    setShowDetails(false);
    resetQuizState();
  }, [resetQuizState]);

  const nextQuizWord = useCallback(async () => {
    if (!totalWords) return;
    const normalizedCardIndex = normalizeCardIndex(cardIndex, totalWords);
    const nextCardIndex = (normalizedCardIndex + 1) % totalWords;
    setCardIndex(nextCardIndex);
    setQuizResult(null);
    setQuizSelectedOption('');
    await persistGroupProgress(statuses, nextCardIndex);
  }, [cardIndex, persistGroupProgress, statuses, totalWords]);

  const submitQuizAnswer = useCallback(
    (selectedDefinition) => {
      if (!currentWord || quizResult !== null) return;

      const isCorrect = selectedDefinition === currentWord.definition;
      setQuizSelectedOption(selectedDefinition);
      setQuizResult(isCorrect ? 'correct' : 'incorrect');
      setQuizScore((prev) => ({
        correct: prev.correct + (isCorrect ? 1 : 0),
        total: prev.total + 1,
      }));

      // Auto-advance if correct after short delay
      if (isCorrect) {
        if (autoAdvanceRef.current !== null) {
          clearTimeout(autoAdvanceRef.current);
        }
        autoAdvanceRef.current = setTimeout(() => {
          autoAdvanceRef.current = null;
          nextQuizWord();
        }, 1200);
      }
    },
    [currentWord, nextQuizWord, quizResult]
  );

  const pronunciationButton = currentWord?.audio_url && (
    <Pressable style={styles.audioIcon} onPress={playPronunciation}>
      <Text style={styles.audioIconText}>🔊</Text>
    </Pressable>
  );

  if (!fontsLoaded) return null;

  if (loading) {
    return (
      <SafeAreaView style={styles.base}>
        <StatusBar style="light" />
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={styles.infoText}>Loading GRE words...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.base}>
      <StatusBar style="light" />
      <View style={styles.container}>
        <Text style={styles.appTitle}>GRE Vocab</Text>

        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
            <Pressable style={styles.retryButton} onPress={loadWords}>
              <Text style={styles.retryText}>Retry</Text>
            </Pressable>
          </View>
        ) : null}

        {selectedGroup ? (
          <View style={styles.deckScreen}>
            <View style={styles.headerRow}>
              <Pressable onPress={studyMode ? backToModes : backToDecks}>
                <Text style={styles.backText}>{studyMode ? '← Modes' : '← Decks'}</Text>
              </Pressable>
              <Text style={styles.groupTitle}>{selectedGroup.group}</Text>
            </View>

            {/* Compact Progress Bar */}
            {studyMode === STUDY_MODES.flashcard && (
              <View style={styles.compactProgressArea}>
                {['mastered', 'reviewing', 'learning'].map((stateKey) => (
                  <View
                    key={stateKey}
                    style={[
                      styles.compactProgressSegment,
                      {
                        backgroundColor: STATE_COLORS[stateKey],
                        flex: counts[stateKey] || MIN_PROGRESS_FLEX,
                      },
                    ]}
                  />
                ))}
              </View>
            )}

            {!studyMode ? (
              <View style={styles.modeList}>
                <Text style={styles.sectionTitle}>Choose a study mode</Text>
                <Pressable
                  style={styles.modeCard}
                  onPress={() => selectMode(STUDY_MODES.flashcard)}
                >
                  <Text style={styles.modeCardTitle}>Flash Cards</Text>
                  <Text style={styles.modeCardMeta}>
                    Tap to reveal details and mark each word.
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.modeCard, !canPlayQuiz && styles.modeCardDisabled]}
                  onPress={() => selectMode(STUDY_MODES.quiz)}
                  disabled={!canPlayQuiz}
                >
                  <Text style={styles.modeCardTitle}>Meaning Quiz</Text>
                  <Text style={styles.modeCardMeta}>
                    Choose the correct definition from options.
                  </Text>
                </Pressable>
              </View>
            ) : currentWord ? (
              <>
                {studyMode === STUDY_MODES.flashcard ? (
                  <>
                    <Pressable
                      style={styles.card}
                      onPress={() => setShowDetails((prev) => !prev)}
                    >
                      <View style={styles.cardTopRow}>
                        {pronunciationButton}
                        <View
                          style={[
                            styles.cardTag,
                            {
                              backgroundColor:
                                STATE_COLORS[statuses[currentWord.word]] || '#212121',
                            },
                          ]}
                        >
                          <Text style={styles.cardTagText}>
                            {STATE_LABELS[statuses[currentWord.word]] ?? 'Unseen'}
                          </Text>
                        </View>
                      </View>

                      <Text style={styles.wordText}>{currentWord.word}</Text>

                      {!showDetails ? (
                        <Text style={styles.tapHint}>Tap to reveal meaning</Text>
                      ) : (
                        <View style={styles.detailsWrap}>
                          <Text style={styles.definitionText}>
                            <Text style={styles.posText}>{currentWord.part_of_speech} </Text>
                            {currentWord.definition}
                          </Text>
                          {currentWord.example && (
                            <Text style={styles.exampleText}>"{currentWord.example}"</Text>
                          )}
                          {currentWord.mnemonic && (
                            <View style={styles.mnemonicBox}>
                              <Text style={styles.mnemonicTitle}>Mnemonic:</Text>
                              <Text style={styles.mnemonicText}>{currentWord.mnemonic}</Text>
                            </View>
                          )}
                          {currentWord.synonyms?.length > 0 && (
                            <Text style={styles.synonymsText}>
                              Synonyms: {currentWord.synonyms.join(', ')}
                            </Text>
                          )}
                        </View>
                      )}
                    </Pressable>

                    <View style={styles.actionRow}>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.learning }]}
                        onPress={() => classifyWord('learning')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.learning }]}>
                          Learn
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.reviewing }]}
                        onPress={() => classifyWord('reviewing')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.reviewing }]}>
                          Review
                        </Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, { borderColor: STATE_COLORS.mastered }]}
                        onPress={() => classifyWord('mastered')}
                      >
                        <Text style={[styles.actionText, { color: STATE_COLORS.mastered }]}>
                          I Know
                        </Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <View style={styles.quizWrap}>
                    <View style={styles.card}>
                      <View style={styles.cardTopRow}>{pronunciationButton}</View>
                      <Text style={styles.quizPrompt}>Choose the correct meaning</Text>
                      <Text style={styles.wordText}>{currentWord.word}</Text>
                    </View>

                    <View style={styles.quizOptionsWrap}>
                      {quizOptions.map((option) => {
                        const isSelected = quizSelectedOption === option;
                        const isCorrectOption = option === currentWord.definition;
                        return (
                          <Pressable
                            key={option}
                            style={[
                              styles.quizOption,
                              isSelected && !isCorrectOption && styles.quizOptionWrong,
                              quizSelectedOption && isCorrectOption && styles.quizOptionCorrect,
                            ]}
                            onPress={() => submitQuizAnswer(option)}
                          >
                            <Text style={styles.quizOptionText}>{option}</Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    {quizResult === 'incorrect' && (
                      <View style={styles.quizFeedback}>
                        <Text style={styles.quizFeedbackTitle}>Not quite ❌</Text>
                        <Text style={styles.quizFeedbackText}>
                          Answer: {currentWord.definition}
                        </Text>
                        <Pressable style={styles.nextButton} onPress={nextQuizWord}>
                          <Text style={styles.nextButtonText}>Next Word</Text>
                        </Pressable>
                      </View>
                    )}

                    <Text style={styles.quizScoreText}>
                      Score: {quizScore.correct}/{quizScore.total}
                    </Text>
                  </View>
                )}
              </>
            ) : null}
          </View>
        ) : (
          <View style={styles.deckListWrap}>
            {/* Global Progress Dashboard */}
            <View style={styles.dashboard}>
              <Text style={styles.dashboardTitle}>Overall Progress</Text>
              <Text style={styles.dashboardStats}>
                {globalCounts.mastered} Mastered • {allWordsCount} Total Words
              </Text>
              <View style={styles.compactProgressArea}>
                <View
                  style={[
                    styles.compactProgressSegment,
                    { backgroundColor: STATE_COLORS.mastered, flex: globalCounts.mastered || MIN_PROGRESS_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    { backgroundColor: STATE_COLORS.reviewing, flex: globalCounts.reviewing || MIN_PROGRESS_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    { backgroundColor: STATE_COLORS.learning, flex: globalCounts.learning || MIN_PROGRESS_FLEX },
                  ]}
                />
                <View
                  style={[
                    styles.compactProgressSegment,
                    {
                      backgroundColor: '#333',
                      flex: globalUnseenCount || 1,
                    },
                  ]}
                />
              </View>
            </View>

            {/* Search Bar */}
            <TextInput
              style={styles.searchInput}
              placeholder="Search words..."
              placeholderTextColor="#888"
              value={searchQuery}
              onChangeText={setSearchQuery}
            />

            {searchQuery ? (
              <FlatList
                data={filteredSearchWords}
                keyExtractor={(item) => item.word}
                contentContainerStyle={styles.deckListContent}
                renderItem={({ item }) => (
                  <View style={styles.searchResultItem}>
                    <Text style={styles.searchWord}>{item.word}</Text>
                    <Text style={styles.searchDef}>{item.definition}</Text>
                  </View>
                )}
                ListEmptyComponent={<Text style={styles.infoText}>No words found.</Text>}
              />
            ) : (
              <FlatList
                data={groups}
                keyExtractor={(item, index) => `${item.group}-${index}`}
                contentContainerStyle={styles.deckListContent}
                renderItem={({ item, index }) => (
                  <Pressable style={styles.deckButton} onPress={() => openGroup(index)}>
                    <Text style={styles.deckTitle}>{item.group}</Text>
                    <Text style={styles.deckMeta}>{item.words?.length ?? 0} words</Text>
                  </Pressable>
                )}
              />
            )}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  base: { flex: 1, backgroundColor: '#050505' },
  container: { flex: 1, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  appTitle: { color: '#fff', fontSize: 28, marginBottom: 16, fontFamily: 'Poppins_700Bold' },
  sectionTitle: { color: '#fff', fontSize: 18, marginBottom: 12, fontFamily: 'Poppins_600SemiBold' },

  // Dashboard & Search
  dashboard: { backgroundColor: '#151515', borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: '#252525' },
  dashboardTitle: { color: '#fff', fontSize: 16, fontFamily: 'Poppins_600SemiBold' },
  dashboardStats: { color: '#bbb', fontSize: 13, fontFamily: 'Poppins_400Regular', marginBottom: 12 },
  searchInput: { backgroundColor: '#111', color: '#fff', borderRadius: 12, padding: 14, fontSize: 15, fontFamily: 'Poppins_400Regular', borderWidth: 1, borderColor: '#252525', marginBottom: 16 },
  searchResultItem: { backgroundColor: '#111', padding: 14, borderRadius: 12, marginBottom: 10, borderWidth: 1, borderColor: '#252525' },
  searchWord: { color: '#fff', fontSize: 16, fontFamily: 'Poppins_600SemiBold' },
  searchDef: { color: '#aaa', fontSize: 13, fontFamily: 'Poppins_400Regular', marginTop: 4 },

  // Decks
  deckListWrap: { flex: 1 },
  deckListContent: { paddingBottom: 20 },
  deckButton: { borderWidth: 1, borderColor: '#252525', borderRadius: 16, padding: 18, marginBottom: 12, backgroundColor: '#111' },
  deckTitle: { color: '#fff', fontSize: 17, fontFamily: 'Poppins_600SemiBold' },
  deckMeta: { color: '#888', marginTop: 4, fontFamily: 'Poppins_400Regular' },

  // Header
  deckScreen: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  backText: { color: '#fff', fontSize: 14, fontFamily: 'Poppins_500Medium' },
  groupTitle: { color: '#fff', fontSize: 16, fontFamily: 'Poppins_600SemiBold' },

  // Flashcards UI
  card: { backgroundColor: '#111', borderRadius: 20, padding: 20, minHeight: 300, borderWidth: 1, borderColor: '#252525', justifyContent: 'center' },
  cardTopRow: { position: 'absolute', top: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  audioIcon: { backgroundColor: '#222', borderRadius: 20, padding: 8 },
  audioIconText: { fontSize: 18 },
  cardTag: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 },
  cardTagText: { color: '#fff', fontSize: 11, textTransform: 'uppercase', fontFamily: 'Poppins_700Bold' },
  wordText: { color: '#fff', fontSize: 36, textAlign: 'center', fontFamily: 'Poppins_700Bold' },
  tapHint: { textAlign: 'center', color: '#666', fontSize: 14, marginTop: 16, fontFamily: 'Poppins_400Regular' },

  // Card Details (Typography improvements)
  detailsWrap: { marginTop: 24, gap: 12 },
  definitionText: { color: '#fff', fontSize: 18, lineHeight: 26, fontFamily: 'Poppins_600SemiBold', textAlign: 'center' },
  posText: { color: '#888', fontStyle: 'italic', fontFamily: 'Poppins_400Regular' },
  exampleText: { color: '#ddd', fontSize: 15, fontStyle: 'italic', textAlign: 'center', fontFamily: 'Poppins_400Regular' },
  mnemonicBox: { backgroundColor: '#1a1a1a', padding: 12, borderRadius: 12, marginTop: 8 },
  mnemonicTitle: { color: '#FF9800', fontSize: 12, textTransform: 'uppercase', fontFamily: 'Poppins_700Bold', marginBottom: 4 },
  mnemonicText: { color: '#eee', fontSize: 14, lineHeight: 20, fontFamily: 'Poppins_500Medium' },
  synonymsText: { color: '#aaa', fontSize: 13, textAlign: 'center', marginTop: 8, fontFamily: 'Poppins_400Regular' },

  // Progress UI
  compactProgressArea: { flexDirection: 'row', height: 6, borderRadius: 3, overflow: 'hidden', marginBottom: 16, backgroundColor: '#333' },
  compactProgressSegment: { height: '100%' },

  // Action Buttons
  actionRow: { flexDirection: 'row', gap: 12, marginTop: 24 },
  actionButton: { flex: 1, paddingVertical: 14, borderRadius: 14, alignItems: 'center', borderWidth: 1, backgroundColor: '#111' },
  actionText: { fontFamily: 'Poppins_600SemiBold', fontSize: 14 },

  // Modes & Quiz
  modeList: { gap: 12 },
  modeCard: { borderWidth: 1, borderColor: '#252525', borderRadius: 16, padding: 18, backgroundColor: '#111' },
  modeCardDisabled: { opacity: 0.5 },
  modeCardTitle: { color: '#fff', fontSize: 18, fontFamily: 'Poppins_600SemiBold' },
  modeCardMeta: { marginTop: 4, color: '#888', fontSize: 13, fontFamily: 'Poppins_400Regular' },

  quizWrap: { flex: 1, gap: 16 },
  quizPrompt: { color: '#888', textAlign: 'center', fontFamily: 'Poppins_500Medium', marginBottom: -10 },
  quizOptionsWrap: { gap: 10 },
  quizOption: { borderWidth: 1, borderColor: '#252525', borderRadius: 14, padding: 16, backgroundColor: '#111' },
  quizOptionCorrect: { borderColor: '#4CAF50', backgroundColor: '#1B2E20' },
  quizOptionWrong: { borderColor: '#F44336', backgroundColor: '#301818' },
  quizOptionText: { color: '#fff', fontSize: 15, fontFamily: 'Poppins_500Medium' },
  quizFeedback: { borderWidth: 1, borderColor: '#252525', borderRadius: 12, padding: 16, backgroundColor: '#111', alignItems: 'center' },
  quizFeedbackTitle: { color: '#F44336', fontSize: 16, fontFamily: 'Poppins_600SemiBold', marginBottom: 8 },
  quizFeedbackText: { color: '#ddd', fontSize: 14, fontFamily: 'Poppins_400Regular', textAlign: 'center', marginBottom: 12 },
  nextButton: { backgroundColor: '#333', borderRadius: 10, paddingVertical: 10, paddingHorizontal: 20 },
  nextButtonText: { color: '#fff', fontFamily: 'Poppins_600SemiBold' },
  quizScoreText: { color: '#888', textAlign: 'center', fontFamily: 'Poppins_500Medium' },
  infoText: { color: '#888', textAlign: 'center', fontFamily: 'Poppins_500Medium', marginTop: 20 },

  errorBox: { marginBottom: 12, borderWidth: 1, borderColor: '#301818', borderRadius: 12, padding: 12, backgroundColor: '#1A0B0B' },
  errorText: { color: '#F44336', marginBottom: 8, fontFamily: 'Poppins_400Regular' },
  retryButton: { borderWidth: 1, borderColor: '#F44336', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, alignSelf: 'flex-start' },
  retryText: { color: '#F44336', fontFamily: 'Poppins_500Medium' },
});
