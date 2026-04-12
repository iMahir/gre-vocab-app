import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
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

const STUDY_MODES = {
  flashcard: 'flashcard',
  quiz: 'quiz',
};

const STORAGE_KEYS = {
  statuses: (groupName) => `gre/statuses/${groupName}`,
  cardIndex: (groupName) => `gre/card-index/${groupName}`,
};

function shuffleValues(values) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
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
  const [cardIndex, setCardIndex] = useState(0);
  const [showDetails, setShowDetails] = useState(false);
  const [quizOptions, setQuizOptions] = useState([]);
  const [quizSelectedOption, setQuizSelectedOption] = useState('');
  const [quizResult, setQuizResult] = useState(null);
  const [quizScore, setQuizScore] = useState({ correct: 0, total: 0 });

  const soundRef = useRef(null);

  const selectedGroup =
    selectedGroupIndex === null ? null : groups[selectedGroupIndex] ?? null;
  const words = selectedGroup?.words ?? [];
  const totalWords = words.length;

  const currentWord = useMemo(() => {
    const wordCount = words.length;
    if (!wordCount) {
      return null;
    }
    const normalizedIndex = ((cardIndex % wordCount) + wordCount) % wordCount;
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
    };
  }, []);

  const persistGroupProgress = useCallback(
    async (nextStatuses, nextCardIndex) => {
      if (!selectedGroup) {
        return;
      }
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
      } catch {
        setError('Could not save progress locally.');
      }
    },
    [cardIndex, selectedGroup, statuses]
  );

  const openGroup = useCallback(async (groupIndex) => {
    const group = groups[groupIndex];
    if (!group) {
      return;
    }

    setSelectedGroupIndex(groupIndex);
    setStudyMode(null);
    setShowDetails(false);
    setQuizOptions([]);
    setQuizSelectedOption('');
    setQuizResult(null);
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
  }, [groups]);

  const backToDecks = useCallback(() => {
    setSelectedGroupIndex(null);
    setStudyMode(null);
    setShowDetails(false);
    setQuizOptions([]);
    setQuizSelectedOption('');
    setQuizResult(null);
    setQuizScore({ correct: 0, total: 0 });
  }, []);

  const playPronunciation = useCallback(async () => {
    if (!currentWord?.audio_url) {
      return;
    }

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
      setQuizOptions([]);
      setQuizSelectedOption('');
      setQuizResult(null);
      return;
    }

    const correctDefinition = currentWord.definition;
    const incorrectDefinitions = shuffleValues(
      Array.from(
        new Set(
          words
            .filter((item) => item.word !== currentWord.word)
            .map((item) => item.definition)
            .filter((definition) => definition && definition !== correctDefinition)
        )
      )
    ).slice(0, 3);

    setQuizOptions(shuffleValues([correctDefinition, ...incorrectDefinitions]));
    setQuizSelectedOption('');
    setQuizResult(null);
  }, [currentWord, studyMode, words]);

  const classifyWord = useCallback(
    async (state) => {
      if (!currentWord || !selectedGroup) {
        return;
      }

      const nextStatuses = {
        ...statuses,
        [currentWord.word]: state,
      };
      if (!totalWords) {
        return;
      }
      const normalizedCardIndex = cardIndex >= 0 ? cardIndex % totalWords : 0;
      const nextCardIndex = (normalizedCardIndex + 1) % totalWords;

      setStatuses(nextStatuses);
      setCardIndex(nextCardIndex);
      setShowDetails(false);
      await persistGroupProgress(nextStatuses, nextCardIndex);
    },
    [cardIndex, currentWord, persistGroupProgress, selectedGroup, statuses, totalWords]
  );

  const selectMode = useCallback((mode) => {
    setStudyMode(mode);
    setShowDetails(false);
    setQuizSelectedOption('');
    setQuizResult(null);
  }, []);

  const backToModes = useCallback(() => {
    setStudyMode(null);
    setShowDetails(false);
    setQuizSelectedOption('');
    setQuizResult(null);
  }, []);

  const submitQuizAnswer = useCallback(
    (selectedDefinition) => {
      if (!currentWord || quizSelectedOption) {
        return;
      }

      const isCorrect = selectedDefinition === currentWord.definition;
      setQuizSelectedOption(selectedDefinition);
      setQuizResult(isCorrect ? 'correct' : 'incorrect');
      setQuizScore((prev) => ({
        correct: prev.correct + (isCorrect ? 1 : 0),
        total: prev.total + 1,
      }));
    },
    [currentWord, quizSelectedOption]
  );

  const nextQuizWord = useCallback(async () => {
    if (!totalWords) {
      return;
    }
    const normalizedCardIndex = cardIndex >= 0 ? cardIndex % totalWords : 0;
    const nextCardIndex = (normalizedCardIndex + 1) % totalWords;
    setCardIndex(nextCardIndex);
    await persistGroupProgress(statuses, nextCardIndex);
  }, [cardIndex, persistGroupProgress, statuses, totalWords]);

  if (!fontsLoaded) {
    return null;
  }

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
        <Text style={styles.appTitle}>GRE Flash Cards</Text>

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
                <Pressable style={styles.modeCard} onPress={() => selectMode(STUDY_MODES.quiz)}>
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
                      <View style={styles.cardTag}>
                        <Text style={styles.cardTagText}>
                          {STATE_LABELS[statuses[currentWord.word]] ?? 'Unseen'}
                        </Text>
                      </View>
                      <Text style={styles.wordText}>{currentWord.word}</Text>
                      {!showDetails ? (
                        <Text style={styles.tapHint}>Tap to reveal meaning →</Text>
                      ) : (
                        <View style={styles.detailsWrap}>
                          <Text style={styles.detailText}>
                            ({currentWord.part_of_speech}) {currentWord.definition}
                          </Text>
                          <Text style={styles.detailText}>Example: {currentWord.example}</Text>
                          <Text style={styles.detailText}>Mnemonic: {currentWord.mnemonic}</Text>
                          <Text style={styles.detailText}>
                            Synonyms: {(currentWord.synonyms ?? []).join(', ')}
                          </Text>
                        </View>
                      )}
                    </Pressable>

                    <Pressable style={styles.audioButton} onPress={playPronunciation}>
                      <Text style={styles.audioButtonText}>▶ Play Pronunciation</Text>
                    </Pressable>

                    <View style={styles.progressArea}>
                      {['mastered', 'reviewing', 'learning'].map((stateKey) => {
                        const value = counts[stateKey];
                        return (
                          <View style={styles.progressRow} key={stateKey}>
                            <Text style={styles.progressLabel}>
                              You have {STATE_LABELS[stateKey].toLowerCase()} {value} out of{' '}
                              {totalWords} words
                            </Text>
                            <View style={styles.progressTrack}>
                              <View
                                style={[
                                  styles.progressFill,
                                  { width: `${totalWords ? (value / totalWords) * 100 : 0}%` },
                                ]}
                              />
                            </View>
                          </View>
                        );
                      })}
                    </View>

                    <View style={styles.actionRow}>
                      <Pressable
                        style={[styles.actionButton, styles.masteredButton]}
                        onPress={() => classifyWord('mastered')}
                      >
                        <Text style={styles.actionText}>I Know</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, styles.reviewButton]}
                        onPress={() => classifyWord('reviewing')}
                      >
                        <Text style={styles.actionText}>Review</Text>
                      </Pressable>
                      <Pressable
                        style={[styles.actionButton, styles.learnButton]}
                        onPress={() => classifyWord('learning')}
                      >
                        <Text style={styles.actionText}>Learn</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <View style={styles.quizWrap}>
                    <View style={styles.card}>
                      <Text style={styles.quizPrompt}>Choose the correct meaning</Text>
                      <Text style={styles.wordText}>{currentWord.word}</Text>
                    </View>

                    <Pressable style={styles.audioButton} onPress={playPronunciation}>
                      <Text style={styles.audioButtonText}>▶ Play Pronunciation</Text>
                    </Pressable>

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

                    {quizResult ? (
                      <View style={styles.quizFeedback}>
                        <Text style={styles.quizFeedbackTitle}>
                          {quizResult === 'correct' ? 'Correct ✅' : 'Not quite ❌'}
                        </Text>
                        <Text style={styles.quizFeedbackText}>
                          Answer: {currentWord.definition}
                        </Text>
                        <Text style={styles.quizFeedbackText}>Example: {currentWord.example}</Text>
                        <Pressable style={styles.nextButton} onPress={nextQuizWord}>
                          <Text style={styles.nextButtonText}>Next Word</Text>
                        </Pressable>
                      </View>
                    ) : null}

                    <Text style={styles.quizScoreText}>
                      Score: {quizScore.correct}/{quizScore.total}
                    </Text>
                  </View>
                )}
              </>
            ) : (
              <Text style={styles.infoText}>No words found in this deck.</Text>
            )}
          </View>
        ) : (
          <View style={styles.deckListWrap}>
            <Text style={styles.sectionTitle}>Choose a deck</Text>
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
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  base: {
    flex: 1,
    backgroundColor: '#050505',
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  appTitle: {
    color: '#fff',
    fontSize: 28,
    lineHeight: 34,
    marginBottom: 12,
    fontFamily: 'Poppins_700Bold',
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 18,
    marginBottom: 12,
    fontFamily: 'Poppins_600SemiBold',
  },
  deckListWrap: {
    flex: 1,
  },
  deckListContent: {
    paddingBottom: 20,
  },
  deckButton: {
    borderWidth: 1,
    borderColor: '#252525',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 18,
    marginBottom: 14,
    backgroundColor: '#101010',
  },
  deckTitle: {
    color: '#fff',
    fontSize: 17,
    fontFamily: 'Poppins_600SemiBold',
  },
  deckMeta: {
    color: '#b8b8b8',
    marginTop: 6,
    fontFamily: 'Poppins_400Regular',
  },
  deckScreen: {
    flex: 1,
  },
  modeList: {
    gap: 12,
  },
  modeCard: {
    borderWidth: 1,
    borderColor: '#252525',
    borderRadius: 18,
    padding: 18,
    backgroundColor: '#101010',
  },
  modeCardTitle: {
    color: '#fff',
    fontSize: 18,
    fontFamily: 'Poppins_600SemiBold',
  },
  modeCardMeta: {
    marginTop: 6,
    color: '#bcbcbc',
    fontSize: 13,
    fontFamily: 'Poppins_400Regular',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  backText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Poppins_500Medium',
  },
  groupTitle: {
    color: '#fff',
    fontSize: 18,
    fontFamily: 'Poppins_600SemiBold',
  },
  card: {
    backgroundColor: '#101010',
    borderRadius: 16,
    padding: 16,
    minHeight: 220,
    borderWidth: 1,
    borderColor: '#2a2a2a',
  },
  cardTag: {
    alignSelf: 'flex-end',
    backgroundColor: '#212121',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cardTagText: {
    color: '#fff',
    fontSize: 11,
    textTransform: 'uppercase',
    fontFamily: 'Poppins_600SemiBold',
  },
  wordText: {
    color: '#fff',
    fontSize: 34,
    textAlign: 'center',
    marginTop: 20,
    marginBottom: 12,
    fontFamily: 'Poppins_700Bold',
  },
  tapHint: {
    textAlign: 'center',
    color: '#b5b5b5',
    fontSize: 14,
    marginTop: 10,
    fontFamily: 'Poppins_400Regular',
  },
  detailsWrap: {
    marginTop: 4,
    gap: 8,
  },
  detailText: {
    color: '#f1f1f1',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'Poppins_400Regular',
  },
  audioButton: {
    borderWidth: 1,
    borderColor: '#2d2d2d',
    borderRadius: 10,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: '#111',
  },
  audioButtonText: {
    color: '#fff',
    fontFamily: 'Poppins_500Medium',
  },
  progressArea: {
    gap: 8,
    marginBottom: 12,
  },
  progressRow: {
    gap: 4,
  },
  progressLabel: {
    color: '#f0f0f0',
    fontSize: 12,
    fontFamily: 'Poppins_400Regular',
  },
  progressTrack: {
    height: 8,
    backgroundColor: '#303030',
    borderRadius: 999,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 999,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 8,
  },
  actionButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  masteredButton: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  reviewButton: {
    backgroundColor: '#d5d5d5',
    borderColor: '#d5d5d5',
  },
  learnButton: {
    backgroundColor: '#9f9f9f',
    borderColor: '#9f9f9f',
  },
  actionText: {
    color: '#000',
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13,
  },
  infoText: {
    color: '#fff',
    textAlign: 'center',
    fontFamily: 'Poppins_500Medium',
  },
  quizWrap: {
    flex: 1,
  },
  quizPrompt: {
    color: '#bfbfbf',
    textAlign: 'center',
    fontFamily: 'Poppins_500Medium',
  },
  quizOptionsWrap: {
    gap: 10,
  },
  quizOption: {
    borderWidth: 1,
    borderColor: '#2b2b2b',
    borderRadius: 12,
    padding: 14,
    backgroundColor: '#111',
  },
  quizOptionCorrect: {
    borderColor: '#5cc48c',
    backgroundColor: '#0f2519',
  },
  quizOptionWrong: {
    borderColor: '#d86d6d',
    backgroundColor: '#2d1616',
  },
  quizOptionText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 20,
    fontFamily: 'Poppins_400Regular',
  },
  quizFeedback: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#2f2f2f',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#111',
    gap: 6,
  },
  quizFeedbackTitle: {
    color: '#fff',
    fontFamily: 'Poppins_600SemiBold',
  },
  quizFeedbackText: {
    color: '#d7d7d7',
    fontSize: 13,
    fontFamily: 'Poppins_400Regular',
  },
  nextButton: {
    marginTop: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#fff',
    paddingVertical: 10,
    alignItems: 'center',
  },
  nextButtonText: {
    color: '#fff',
    fontFamily: 'Poppins_600SemiBold',
  },
  quizScoreText: {
    marginTop: 10,
    color: '#fff',
    textAlign: 'center',
    fontFamily: 'Poppins_500Medium',
  },
  errorBox: {
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#363636',
    borderRadius: 12,
    padding: 12,
    backgroundColor: '#121212',
  },
  errorText: {
    color: '#fff',
    marginBottom: 8,
    fontFamily: 'Poppins_400Regular',
  },
  retryButton: {
    borderWidth: 1,
    borderColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  retryText: {
    color: '#fff',
    fontFamily: 'Poppins_500Medium',
  },
});
