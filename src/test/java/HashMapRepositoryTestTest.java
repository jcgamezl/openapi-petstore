package org.openapitools.repository;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.*;

import static org.junit.jupiter.api.Assertions.*;

class HashMapRepositoryTest {

    private HashMapRepository<TestEntity, String> repository;
    private TestEntity entity1, entity2;

    @BeforeEach
    void setUp() {
        repository = new HashMapRepository<>() {
            @Override
            public <S extends TestEntity> String getEntityId(S entity) {
                return entity.getId();
            }
        };
        entity1 = new TestEntity("1", "Entity 1");
        entity2 = new TestEntity("2", "Entity 2");
    }

    @AfterEach
    void tearDown() {
        repository = null;
        entity1 = null;
        entity2 = null;
    }

    @Test
    void getEntityId_ShouldReturnEntityId() {
        // Arrange
        TestEntity entity = new TestEntity("123", "Test Entity");

        // Act
        String entityId = repository.getEntityId(entity);

        // Assert
        assertEquals("123", entityId);
    }

    @Test
    void save_ShouldSaveEntity() {
        // Act
        TestEntity savedEntity = repository.save(entity1);

        // Assert
        assertEquals(entity1, savedEntity);
        assertTrue(repository.existsById(entity1.getId()));
    }

    @Test
    void save_ShouldThrowExceptionForNullEntity() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.save(null));
    }

    @Test
    void save_ShouldThrowExceptionForEntityWithNullId() {
        // Arrange
        TestEntity entityWithNullId = new TestEntity(null, "Test Entity");

        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.save(entityWithNullId));
    }

    @Test
    void save_ShouldOverwriteExistingEntity() {
        // Arrange
        repository.save(entity1);
        TestEntity updatedEntity = new TestEntity("1", "Updated Entity");

        // Act
        TestEntity savedEntity = repository.save(updatedEntity);

        // Assert
        assertEquals(updatedEntity, savedEntity);
        assertEquals(1, repository.count());
        assertEquals("Updated Entity", repository.findById("1").get().getName());
    }

    @Test
    void saveAll_ShouldSaveAllEntities() {
        // Arrange
        List<TestEntity> entities = Arrays.asList(entity1, entity2);

        // Act
        List<TestEntity> savedEntities = repository.saveAll(entities);

        // Assert
        assertEquals(entities, savedEntities);
        assertTrue(repository.existsById(entity1.getId()));
        assertTrue(repository.existsById(entity2.getId()));
    }

    @Test
    void saveAll_ShouldThrowExceptionForNullEntities() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.saveAll(null));
    }

    @Test
    void saveAll_ShouldHandleEmptyIterable() {
        // Arrange
        List<TestEntity> emptyList = new ArrayList<>();

        // Act
        List<TestEntity> savedEntities = repository.saveAll(emptyList);

        // Assert
        assertTrue(savedEntities.isEmpty());
        assertEquals(0, repository.count());
    }

    @Test
    void findAll_ShouldReturnAllSavedEntities() {
        // Arrange
        repository.save(entity1);
        repository.save(entity2);

        // Act
        Collection<TestEntity> allEntities = repository.findAll();

        // Assert
        assertEquals(2, allEntities.size());
        assertTrue(allEntities.contains(entity1));
        assertTrue(allEntities.contains(entity2));
    }

    @Test
    void findAll_ShouldReturnEmptyCollectionWhenNoEntities() {
        // Act
        Collection<TestEntity> allEntities = repository.findAll();

        // Assert
        assertTrue(allEntities.isEmpty());
    }

    @Test
    void count_ShouldReturnNumberOfSavedEntities() {
        // Arrange
        repository.save(entity1);
        repository.save(entity2);

        // Act
        long count = repository.count();

        // Assert
        assertEquals(2, count);
    }

    @Test
    void count_ShouldReturnZeroWhenNoEntities() {
        // Act
        long count = repository.count();

        // Assert
        assertEquals(0, count);
    }

    @Test
    void delete_ShouldDeleteEntity() {
        // Arrange
        repository.save(entity1);

        // Act
        repository.delete(entity1);

        // Assert
        assertFalse(repository.existsById(entity1.getId()));
    }

    @Test
    void delete_ShouldThrowExceptionForNullEntity() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.delete(null));
    }

    @Test
    void delete_ShouldHandleNonExistentEntity() {
        // Arrange
        TestEntity nonExistentEntity = new TestEntity("999", "Non-existent");

        // Act & Assert
        assertDoesNotThrow(() -> repository.delete(nonExistentEntity));
    }

    @Test
    void deleteAll_ShouldDeleteAllEntities() {
        // Arrange
        repository.save(entity1);
        repository.save(entity2);

        // Act
        repository.deleteAll();

        // Assert
        assertEquals(0, repository.count());
    }

    @Test
    void deleteAll_WithIterable_ShouldDeleteSpecifiedEntities() {
        // Arrange
        TestEntity entity3 = new TestEntity("3", "Entity 3");
        repository.save(entity1);
        repository.save(entity2);
        repository.save(entity3);
        List<TestEntity> entitiesToDelete = Arrays.asList(entity1, entity2);

        // Act
        repository.deleteAll(entitiesToDelete);

        // Assert
        assertEquals(1, repository.count());
        assertFalse(repository.existsById(entity1.getId()));
        assertFalse(repository.existsById(entity2.getId()));
        assertTrue(repository.existsById(entity3.getId()));
    }

    @Test
    void deleteAll_ShouldThrowExceptionForNullEntities() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.deleteAll((Iterable<TestEntity>) null));
    }

    @Test
    void deleteById_ShouldDeleteEntityById() {
        // Arrange
        repository.save(entity1);

        // Act
        repository.deleteById(entity1.getId());

        // Assert
        assertFalse(repository.existsById(entity1.getId()));
    }

    @Test
    void deleteById_ShouldThrowExceptionForNullId() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.deleteById(null));
    }

    @Test
    void deleteById_ShouldHandleNonExistentId() {
        // Act & Assert
        assertDoesNotThrow(() -> repository.deleteById("non-existent"));
    }

    @Test
    void findAllById_ShouldReturnAllEntitiesWithGivenIds() {
        // Arrange
        repository.save(entity1);
        repository.save(entity2);
        List<String> ids = Arrays.asList(entity1.getId(), entity2.getId());

        // Act
        List<TestEntity> foundEntities = repository.findAllById(ids);

        // Assert
        assertEquals(2, foundEntities.size());
        assertTrue(foundEntities.contains(entity1));
        assertTrue(foundEntities.contains(entity2));
    }

    @Test
    void findAllById_ShouldThrowExceptionForNullIds() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.findAllById(null));
    }

    @Test
    void findAllById_ShouldReturnEmptyListForEmptyIds() {
        // Arrange
        List<String> emptyIds = new ArrayList<>();

        // Act
        List<TestEntity> foundEntities = repository.findAllById(emptyIds);

        // Assert
        assertTrue(foundEntities.isEmpty());
    }

    @Test
    void findAllById_ShouldSkipNonExistentIds() {
        // Arrange
        repository.save(entity1);
        List<String> ids = Arrays.asList(entity1.getId(), "non-existent");

        // Act
        List<TestEntity> foundEntities = repository.findAllById(ids);

        // Assert
        assertEquals(1, foundEntities.size());
        assertTrue(foundEntities.contains(entity1));
    }

    @Test
    void existsById_ShouldReturnTrueForExistingId() {
        // Arrange
        repository.save(entity1);

        // Act
        boolean exists = repository.existsById(entity1.getId());

        // Assert
        assertTrue(exists);
    }

    @Test
    void existsById_ShouldReturnFalseForNonExistingId() {
        // Act
        boolean exists = repository.existsById("non-existing-id");

        // Assert
        assertFalse(exists);
    }

    @Test
    void existsById_ShouldThrowExceptionForNullId() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.existsById(null));
    }

    @Test
    void findOne_ShouldReturnEntityForExistingId() {
        // Arrange
        repository.save(entity1);

        // Act
        TestEntity foundEntity = repository.findOne(entity1.getId());

        // Assert
        assertEquals(entity1, foundEntity);
    }

    @Test
    void findOne_ShouldReturnNullForNonExistingId() {
        // Act
        TestEntity foundEntity = repository.findOne("non-existing-id");

        // Assert
        assertNull(foundEntity);
    }

    @Test
    void findOne_ShouldThrowExceptionForNullId() {
        // Act & Assert
        assertThrows(IllegalArgumentException.class, () -> repository.findOne(null));
    }

    @Test
    void findById_ShouldReturnOptionalWithEntityForExistingId() {
        // Arrange
        repository.save(entity1);

        // Act
        Optional<TestEntity> foundEntity = repository.findById(entity1.getId());

        // Assert
        assertTrue(foundEntity.isPresent());
        assertEquals(entity1, foundEntity.get());
    }

    @Test
    void findById_ShouldReturnEmptyOptionalForNonExistingId() {
        // Act
        Optional<TestEntity> foundEntity = repository.findById("non-existing-id");

        // Assert
        assertFalse(foundEntity.isPresent());
    }

    @Test
    void findById_ShouldReturnEmptyOptionalForNullId() {
        // Act
        Optional<TestEntity> foundEntity = repository.findById(null);

        // Assert
        assertFalse(foundEntity.isPresent());
    }

    private static class TestEntity {
        private final String id;
        private final String name;

        TestEntity(String id, String name) {
            this.id = id;
            this.name = name;
        }

        String getId() {
            return id;
        }

        String getName() {
            return name;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (o == null || getClass() != o.getClass()) return false;
            TestEntity that = (TestEntity) o;
            return Objects.equals(id, that.id) && Objects.equals(name, that.name);
        }

        @Override
        public int hashCode() {
            return Objects.hash(id, name);
        }
    }
}